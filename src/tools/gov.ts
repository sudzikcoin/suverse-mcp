/** The 3 government tools: the dispatcher + 2 premium dedicated endpoints. */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { ENDPOINTS } from "../endpoints.js";
import { callPaid, err, priced, type ToolContext } from "./shared.js";

export function registerGovTools(server: McpServer, ctx: ToolContext): void {
  // gov_query — dispatcher for 128 services. Body: { service, params }.
  {
    const spec = ENDPOINTS.gov_query!;
    server.registerTool(
      spec.tool,
      {
        description: priced(spec),
        inputSchema: {
          service: z
            .string()
            .describe('Service id, e.g. "sec.company_info" or "nps.parks". See gov_list_services.'),
          params: z.record(z.unknown()).optional().describe("Service-specific parameters object."),
        },
      },
      async (args) => {
        const a = args as Record<string, unknown>;
        if (!a.service || typeof a.service !== "string") {
          return err("gov_query requires a `service` id. Discover ids with gov_list_services.");
        }
        return callPaid(ctx, spec, { service: a.service, params: a.params ?? {} });
      },
    );
  }

  // gov_cms_open_payments — body: { params: { physician_npi, year } }.
  {
    const spec = ENDPOINTS.gov_cms_open_payments!;
    server.registerTool(
      spec.tool,
      {
        description: priced(spec),
        inputSchema: {
          physician_npi: z.string().describe("10-digit NPI."),
          year: z.number().int().optional().describe("Program year, e.g. 2023."),
        },
      },
      async (args) => {
        const a = args as Record<string, unknown>;
        if (!a.physician_npi) return err("gov_cms_open_payments requires physician_npi.");
        const params: Record<string, unknown> = { physician_npi: a.physician_npi };
        if (a.year != null) params.year = a.year;
        return callPaid(ctx, spec, { params });
      },
    );
  }

  // gov_fbi_crime_data — body: { params: { state, offense, from_year, to_year } }.
  {
    const spec = ENDPOINTS.gov_fbi_crime_data!;
    server.registerTool(
      spec.tool,
      {
        description: priced(spec),
        inputSchema: {
          state: z.string().describe("Two-letter state code, e.g. TX."),
          offense: z.string().optional().describe('e.g. "violent-crime", "burglary".'),
          from_year: z.number().int().optional(),
          to_year: z.number().int().optional(),
        },
      },
      async (args) => {
        const a = args as Record<string, unknown>;
        if (!a.state) return err("gov_fbi_crime_data requires a state code.");
        const params: Record<string, unknown> = { state: a.state };
        for (const k of ["offense", "from_year", "to_year"]) if (a[k] != null) params[k] = a[k];
        return callPaid(ctx, spec, { params });
      },
    );
  }
}
