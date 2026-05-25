/** Free utility tools: service discovery, cost estimation, and wallet balance. */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { ENDPOINTS, GOV_SERVICES_PATH, microToUsd } from "../endpoints.js";
import { log } from "../logger.js";
import { err, ok, type ToolContext } from "./shared.js";

export const FREE_TOOLS = ["gov_list_services", "suverse_estimate_cost", "suverse_balance"] as const;

export function registerUtilTools(server: McpServer, ctx: ToolContext): void {
  // gov_list_services — free catalog of the 128 gov_query service ids + params.
  server.registerTool(
    "gov_list_services",
    {
      description:
        "List all SuVerse government services callable via gov_query (id, category, description, " +
        "params). FREE — no payment.",
      inputSchema: {
        category: z.string().optional().describe("Optional filter: data | search | maps."),
      },
    },
    async (args) => {
      try {
        const data = await ctx.http.freeGet(GOV_SERVICES_PATH);
        const a = args as Record<string, unknown>;
        if (a.category && data && typeof data === "object") {
          const arr = (data as { services?: unknown[] }).services;
          if (Array.isArray(arr)) {
            const filtered = arr.filter(
              (s) => (s as { category?: string }).category === a.category,
            );
            return ok({ count: filtered.length, services: filtered });
          }
        }
        return ok(data);
      } catch (e) {
        return err(`Could not fetch the service catalog: ${(e as Error).message}`);
      }
    },
  );

  // suverse_estimate_cost — free, offline price lookup for one or many calls.
  server.registerTool(
    "suverse_estimate_cost",
    {
      description:
        "Estimate the USDC cost of one or more tool calls WITHOUT paying. Useful before batch " +
        "operations. FREE — no payment.",
      inputSchema: {
        tool: z.string().optional().describe("A single tool name to price."),
        calls: z
          .array(z.object({ tool: z.string(), args: z.record(z.unknown()).optional() }))
          .optional()
          .describe("A batch of calls to price."),
      },
    },
    async (args) => {
      const a = args as { tool?: string; calls?: { tool: string }[] };
      const names = a.calls?.map((c) => c.tool) ?? (a.tool ? [a.tool] : []);
      if (names.length === 0) return err("Provide `tool` or a `calls` array.");
      let totalMicro = 0;
      const lines = names.map((name) => {
        const spec = ENDPOINTS[name];
        const micro = spec?.priceMicro ?? 0;
        totalMicro += micro;
        return {
          tool: name,
          paid: !!spec,
          price_usdc: spec ? microToUsd(micro) : "0.00 (free)",
          price_micro: micro,
        };
      });
      return ok({ calls: lines, total_usdc: microToUsd(totalMicro), total_micro: totalMicro });
    },
  );

  // suverse_balance — free on-chain USDC balance + calls-remaining per tool.
  server.registerTool(
    "suverse_balance",
    {
      description:
        "Read the configured Base wallet's on-chain USDC balance and how many calls remain for " +
        "each tool at that balance. FREE — no payment.",
      inputSchema: {},
    },
    async () => {
      try {
        const micro = await ctx.http.usdcBalanceMicro();
        const balanceMicro = Number(micro);
        const remaining = Object.values(ENDPOINTS)
          .map((s) => ({
            tool: s.tool,
            price_usdc: microToUsd(s.priceMicro),
            calls_remaining: Math.floor(balanceMicro / s.priceMicro),
          }))
          .sort((x, y) => y.calls_remaining - x.calls_remaining);
        log.info("balance read", { address: ctx.http.address, balanceMicro });
        return ok({
          wallet: ctx.http.address,
          network: ctx.cfg.network,
          balance_usdc: microToUsd(balanceMicro),
          balance_micro: balanceMicro,
          calls_remaining: remaining,
        });
      } catch (e) {
        return err(
          `Could not read USDC balance for ${ctx.http.address}: ${(e as Error).message}. ` +
            `Set SUVERSE_BASE_RPC_URL if the default Base RPC is rate-limited.`,
        );
      }
    },
  );
}
