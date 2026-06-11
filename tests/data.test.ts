/** Tests for the custody-free /v1/data verdict tools: client-side base58
 *  validation, 402-info passthrough, and paid-forward header handling. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/config.js";
import { IdempotencyStore } from "../src/idempotency.js";
import { buildServer } from "../src/server.js";
import type { ToolContext } from "../src/tools/shared.js";
import type { SuverseHttp } from "../src/x402.js";

const PK = ("0x" + "1".repeat(64)) as `0x${string}`;
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const WALLET = "26edvkZ99Lfs6LEwfSbfbJG17NM6z4BqrWMk7Z8hTe4D";

function makeCtx(): ToolContext {
  const http: SuverseHttp = {
    address: "0x09939648B56A776de9783eaE750A7fBE725761f1",
    paidRequest: vi.fn(async () => ({ data: {} })),
    freeGet: vi.fn(async () => ({})),
    usdcBalanceMicro: vi.fn(async () => 0n),
  };
  return { http, cfg: loadConfig({ SUVERSE_BASE_PRIVATE_KEY: PK }), idem: new IdempotencyStore(120_000) };
}

async function connect(): Promise<Client> {
  const server = buildServer(makeCtx());
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  await client.connect(clientT);
  return client;
}

const text = (r: unknown) =>
  (r as { content: { text?: string }[] }).content[0]?.text ?? "";
const isError = (r: unknown) => (r as { isError?: boolean }).isError === true;

/** Minimal but shape-faithful x402 v2 challenge, as proxy.suverse.io emits it. */
function challenge(amountMicro: string) {
  return {
    x402Version: 2,
    resource: { url: "https://proxy.suverse.io/v1/data/x", description: "d", mimeType: "application/json" },
    accepts: [
      { scheme: "exact", network: "eip155:8453", asset: "0x8335…", payTo: "0x260f…", amount: amountMicro },
      { scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", asset: "EPjF…", payTo: "CBYM…", amount: amountMicro },
      { scheme: "exact_cosmos_authz", network: "cosmos:noble-1", asset: "uusdc", payTo: "noble1…", amount: amountMicro },
    ],
  };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => jsonResponse(402, challenge("100000")));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("client-side input validation (no network)", () => {
  it("rejects a non-base58 wallet with a clear message before any request", async () => {
    const client = await connect();
    const res = await client.callTool({
      name: "suverse_wallet_reputation",
      arguments: { wallet: "0x3869dE7597bDEa0172B97143f3eed806D8b84bf3" }, // EVM, contains 0/l
    });
    expect(isError(res)).toBe(true);
    expect(text(res)).toMatch(/base58 Solana address/);
    expect(text(res)).toMatch(/No request was sent/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a too-short token mint before any request", async () => {
    const client = await connect();
    const res = await client.callTool({ name: "suverse_token_check", arguments: { token: "abc" } });
    expect(isError(res)).toBe(true);
    expect(text(res)).toMatch(/base58 Solana mint address/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("unauthenticated path → 402 info structure", () => {
  it("market pulse returns price 0.10 + accepts passthrough + how_to_pay", async () => {
    const client = await connect();
    const res = await client.callTool({ name: "suverse_market_pulse", arguments: {} });
    expect(isError(res)).toBe(false);
    const out = JSON.parse(text(res));
    expect(out.status).toBe("payment_required");
    expect(out.price_usdc).toBe("0.10");
    expect(out.x402.accepts).toHaveLength(3);
    expect(out.x402.accepts.map((a: { network: string }) => a.network)).toContain("cosmos:noble-1");
    expect(out.how_to_pay).toMatch(/payment_signature/);
    expect(out.endpoint).toEqual({
      method: "POST",
      url: "https://proxy.suverse.io/v1/data/crypto-market-pulse",
      body: {},
    });
    // The unpaid probe must not carry any payment headers.
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)["PAYMENT-SIGNATURE"]).toBeUndefined();
    expect((init.headers as Record<string, string>)["X-PAYMENT"]).toBeUndefined();
  });

  it("token check posts the mint and reports its own price", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(402, challenge("50000")));
    const client = await connect();
    const res = await client.callTool({ name: "suverse_token_check", arguments: { token: BONK } });
    const out = JSON.parse(text(res));
    expect(out.status).toBe("payment_required");
    expect(out.price_usdc).toBe("0.05");
    expect(out.endpoint.body).toEqual({ token: BONK });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://proxy.suverse.io/v1/data/token-check");
    expect(JSON.parse(init.body as string)).toEqual({ token: BONK });
  });
});

describe("paid-forward path", () => {
  it("forwards payment_signature as PAYMENT-SIGNATURE + X-PAYMENT and returns the verdict", async () => {
    const receipt = { success: true, transaction: "0xabc", network: "eip155:8453" };
    const verdict = { verdict: { skill_tier: "elite" }, signals: {}, data_quality: {}, raw: {} };
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, verdict, {
        "payment-response": Buffer.from(JSON.stringify(receipt)).toString("base64"),
      }),
    );
    const client = await connect();
    const res = await client.callTool({
      name: "suverse_wallet_reputation",
      arguments: { wallet: WALLET, payment_signature: "c2lnbmVkLWVudmVsb3Bl" },
    });
    expect(isError(res)).toBe(false);
    const out = JSON.parse(text(res));
    expect(out.status).toBe("paid");
    expect(out.data).toEqual(verdict);
    expect(out.payment_receipt).toEqual(receipt);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["PAYMENT-SIGNATURE"]).toBe("c2lnbmVkLWVudmVsb3Bl");
    expect(headers["X-PAYMENT"]).toBe("c2lnbmVkLWVudmVsb3Bl");
  });

  it("maps a rejected signature (402 again) to a clear error", async () => {
    const client = await connect();
    const res = await client.callTool({
      name: "suverse_market_pulse",
      arguments: { payment_signature: "ZXhwaXJlZA==" },
    });
    expect(isError(res)).toBe(true);
    expect(text(res)).toMatch(/not accepted/);
  });
});

describe("server-side 422", () => {
  it("surfaces the endpoint's rejection body", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(422, { error: "wallet_required" }));
    const client = await connect();
    const res = await client.callTool({
      name: "suverse_wallet_reputation",
      arguments: { wallet: WALLET },
    });
    expect(isError(res)).toBe(true);
    expect(text(res)).toMatch(/HTTP 422/);
    expect(text(res)).toMatch(/wallet_required/);
  });
});
