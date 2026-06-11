import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/config.js";
import { IdempotencyStore } from "../src/idempotency.js";
import { buildServer } from "../src/server.js";
import type { ToolContext } from "../src/tools/shared.js";
import { PaymentCapError, type SuverseHttp } from "../src/x402.js";

const PK = ("0x" + "1".repeat(64)) as `0x${string}`;

function makeCtx(http: Partial<SuverseHttp> = {}): ToolContext {
  const base: SuverseHttp = {
    address: "0x09939648B56A776de9783eaE750A7fBE725761f1",
    paidRequest: vi.fn(async (path: string) => ({ data: { ok: true, path } })),
    freeGet: vi.fn(async () => ({ services: [{ id: "sec.company_info", category: "data" }] })),
    usdcBalanceMicro: vi.fn(async () => 1_000_000n),
  };
  return {
    http: { ...base, ...http },
    cfg: loadConfig({ SUVERSE_BASE_PRIVATE_KEY: PK }),
    idem: new IdempotencyStore(120_000),
  };
}

async function connect(ctx: ToolContext): Promise<Client> {
  const server = buildServer(ctx);
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  await client.connect(clientT);
  return client;
}

const text = (r: { content: { type: string; text?: string }[] }) => r.content[0]?.text ?? "";

describe("tool registration", () => {
  it("registers all 19 tools", async () => {
    const client = await connect(makeCtx());
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names.length).toBe(19);
    for (const n of [
      "freight_parse_ratecon", "freight_parse_bol_pod", "freight_parse_fuel_receipt",
      "freight_parse_w9", "freight_parse_insurance_cert", "freight_parse_permit",
      "freight_truck_route", "freight_calculate_tolls", "freight_trip_telematics",
      "gov_query", "gov_cms_open_payments", "gov_fbi_crime_data",
      "gov_list_services", "suverse_estimate_cost", "suverse_balance",
      "suverse_search_endpoints",
      "suverse_market_pulse", "suverse_wallet_reputation", "suverse_token_check",
    ]) {
      expect(names).toContain(n);
    }
  });

  it("puts the price in paid tool descriptions", async () => {
    const client = await connect(makeCtx());
    const { tools } = await client.listTools();
    const tr = tools.find((t) => t.name === "freight_truck_route");
    expect(tr?.description).toContain("$0.50 USDC");
  });
});

describe("paid tools", () => {
  it("calls the endpoint and returns its data", async () => {
    const ctx = makeCtx();
    const client = await connect(ctx);
    const res = await client.callTool({ name: "gov_query", arguments: { service: "sec.company_info" } });
    expect(JSON.parse(text(res as never))).toMatchObject({ ok: true, path: "/v1/gov" });
    expect(ctx.http.paidRequest).toHaveBeenCalledTimes(1);
  });

  it("validates required inputs without paying", async () => {
    const ctx = makeCtx();
    const client = await connect(ctx);
    const res = await client.callTool({ name: "freight_parse_ratecon", arguments: { mode: "llm" } });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(text(res as never)).toMatch(/Provide one of/);
    expect(ctx.http.paidRequest).not.toHaveBeenCalled();
  });

  it("does not double-pay an identical repeat (client idempotency)", async () => {
    const ctx = makeCtx();
    const client = await connect(ctx);
    const args = { service: "sec.company_info", params: { ticker: "AAPL" } };
    await client.callTool({ name: "gov_query", arguments: args });
    await client.callTool({ name: "gov_query", arguments: args });
    expect(ctx.http.paidRequest).toHaveBeenCalledTimes(1);
  });

  it("surfaces a cap-exceeded error clearly", async () => {
    const ctx = makeCtx({
      paidRequest: vi.fn(async () => {
        throw new PaymentCapError("Quoted 0.90 USDC exceeds the allowed 0.50 for this call.");
      }),
    });
    const client = await connect(ctx);
    const res = await client.callTool({ name: "freight_truck_route", arguments: { origin: {}, destination: {} } });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(text(res as never)).toMatch(/exceeds the allowed/);
  });

  it("maps a 402 to an insufficient-balance hint", async () => {
    const ctx = makeCtx({
      paidRequest: vi.fn(async () => {
        throw { response: { status: 402, data: { error: "settle failed" } } };
      }),
    });
    const client = await connect(ctx);
    const res = await client.callTool({ name: "gov_query", arguments: { service: "x" } });
    expect(text(res as never)).toMatch(/suverse_balance/);
  });
});

describe("free tools", () => {
  it("gov_list_services fetches the catalog without paying", async () => {
    const ctx = makeCtx();
    const client = await connect(ctx);
    const res = await client.callTool({ name: "gov_list_services", arguments: {} });
    expect(text(res as never)).toContain("sec.company_info");
    expect(ctx.http.freeGet).toHaveBeenCalledWith("/v1/gov/services");
    expect(ctx.http.paidRequest).not.toHaveBeenCalled();
  });

  it("suverse_estimate_cost totals a batch offline", async () => {
    const ctx = makeCtx();
    const client = await connect(ctx);
    const res = await client.callTool({
      name: "suverse_estimate_cost",
      arguments: { calls: [{ tool: "freight_truck_route" }, { tool: "gov_query" }] },
    });
    expect(JSON.parse(text(res as never)).total_micro).toBe(505_000);
    expect(ctx.http.paidRequest).not.toHaveBeenCalled();
  });

  it("suverse_balance reports calls remaining", async () => {
    const ctx = makeCtx();
    const client = await connect(ctx);
    const res = await client.callTool({ name: "suverse_balance", arguments: {} });
    const out = JSON.parse(text(res as never));
    expect(out.balance_usdc).toBe("1.00");
    const tele = out.calls_remaining.find((r: { tool: string }) => r.tool === "freight_trip_telematics");
    expect(tele.calls_remaining).toBe(100); // 1.00 / 0.01
  });
});
