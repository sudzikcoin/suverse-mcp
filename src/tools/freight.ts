/** The 9 freight tools. */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { ENDPOINTS } from "../endpoints.js";
import { callPaid, err, priced, type ToolContext, type ToolResult } from "./shared.js";

/** Return an error result if none of `fields` is present in args. */
function requireOneOf(args: Record<string, unknown>, fields: string[]): ToolResult | null {
  const has = fields.some((f) => args[f] != null && args[f] !== "");
  return has ? null : err(`Provide one of: ${fields.join(", ")}.`);
}

const fileDoc = "Local path to a file on this machine; the server reads it, verifies its type, and base64-encodes it.";
const modeDoc = "fast=regex, llm=GPT-4o-mini, ocr=scanned/image OCR.";

const coordinate = z
  .object({
    lat: z.number().optional(),
    lon: z.number().optional(),
    address: z.string().optional(),
  })
  .describe("A point as {lat, lon} or {address}.");

export function registerFreightTools(server: McpServer, ctx: ToolContext): void {
  // --- document parsers: PDF/text (ratecon, bol_pod) ---
  for (const tool of ["freight_parse_ratecon", "freight_parse_bol_pod"] as const) {
    const spec = ENDPOINTS[tool]!;
    server.registerTool(
      tool,
      {
        description: priced(spec),
        inputSchema: {
          mode: z.enum(["fast", "llm", "ocr"]).optional().describe(modeDoc),
          text: z.string().optional().describe("Raw document text."),
          pdf_base64: z.string().optional().describe("Base64-encoded PDF."),
          file_path: z.string().optional().describe(fileDoc + " (PDF)"),
        },
      },
      async (args) => {
        const a = args as Record<string, unknown>;
        return requireOneOf(a, ["text", "pdf_base64", "file_path"]) ?? callPaid(ctx, spec, a);
      },
    );
  }

  // --- document parsers: PDF/image/text (fuel, w9, insurance_cert) ---
  for (const tool of [
    "freight_parse_fuel_receipt",
    "freight_parse_w9",
    "freight_parse_insurance_cert",
  ] as const) {
    const spec = ENDPOINTS[tool]!;
    server.registerTool(
      tool,
      {
        description: priced(spec),
        inputSchema: {
          mode: z.enum(["auto", "fast", "llm", "ocr"]).optional().describe(modeDoc),
          text: z.string().optional().describe("Raw document text."),
          pdf_base64: z.string().optional().describe("Base64-encoded PDF."),
          image_base64: z.string().optional().describe("Base64-encoded image."),
          file_path: z.string().optional().describe(fileDoc + " (PDF or image)"),
        },
      },
      async (args) => {
        const a = args as Record<string, unknown>;
        return (
          requireOneOf(a, ["text", "pdf_base64", "image_base64", "file_path"]) ??
          callPaid(ctx, spec, a)
        );
      },
    );
  }

  // --- permit parser (files[] / pdf / text) ---
  {
    const spec = ENDPOINTS.freight_parse_permit!;
    server.registerTool(
      spec.tool,
      {
        description: priced(spec),
        inputSchema: {
          files: z
            .array(
              z.object({
                data: z.string().describe("Base64-encoded PDF/image."),
                media_type: z.string().describe("e.g. application/pdf, image/png."),
                name: z.string().optional(),
              }),
            )
            .optional()
            .describe("Permit documents."),
          pdf_base64: z.string().optional().describe("Base64-encoded permit PDF."),
          text: z.string().optional().describe("Raw permit text."),
          file_path: z.string().optional().describe(fileDoc + " (PDF or image)"),
        },
      },
      async (args) => {
        const a = args as Record<string, unknown>;
        return requireOneOf(a, ["files", "pdf_base64", "text", "file_path"]) ?? callPaid(ctx, spec, a);
      },
    );
  }

  // --- truck_route ---
  {
    const spec = ENDPOINTS.freight_truck_route!;
    server.registerTool(
      spec.tool,
      {
        description: priced(spec),
        inputSchema: {
          origin: coordinate,
          destination: coordinate,
          via_points: z.array(coordinate).optional(),
          truck: z
            .object({
              height_ft: z.number().optional(),
              weight_lbs: z.number().optional(),
              axles: z.number().optional(),
              hazmat: z.boolean().optional(),
            })
            .optional()
            .describe("Truck profile for legal routing."),
          include_weigh_stations: z.boolean().optional(),
          include_truck_stops: z.boolean().optional(),
        },
      },
      async (args) => callPaid(ctx, spec, args as Record<string, unknown>),
    );
  }

  // --- calculate_tolls ---
  {
    const spec = ENDPOINTS.freight_calculate_tolls!;
    server.registerTool(
      spec.tool,
      {
        description: priced(spec),
        inputSchema: {
          polyline: z
            .union([z.string(), z.array(z.array(z.number()))])
            .describe("Encoded polyline6 string OR array of [lat, lon] points."),
          axles: z.number().optional(),
          height_ft: z.number().optional(),
          toll_maneuvers: z.array(z.unknown()).optional(),
        },
      },
      async (args) => callPaid(ctx, spec, args as Record<string, unknown>),
    );
  }

  // --- trip_telematics ---
  {
    const spec = ENDPOINTS.freight_trip_telematics!;
    server.registerTool(
      spec.tool,
      {
        description: priced(spec),
        inputSchema: {
          pings: z
            .array(
              z.object({
                lat: z.number(),
                lon: z.number(),
                timestamp: z.string(),
                speed: z.number().optional(),
                fuelRateGph: z.number().optional(),
              }),
            )
            .describe("Ordered GPS pings."),
          options: z
            .object({ assumed_mpg: z.number().optional(), fuel_price: z.number().optional() })
            .optional(),
        },
      },
      async (args) => {
        const a = args as Record<string, unknown>;
        if (!Array.isArray(a.pings) || a.pings.length < 2) {
          return err("trip_telematics needs at least 2 GPS pings.");
        }
        return callPaid(ctx, spec, a);
      },
    );
  }
}
