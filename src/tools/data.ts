/**
 * Aggregated verdict endpoints (proxy.suverse.io /v1/data/*), exposed
 * custody-free: unlike the gov/freight tools, this server NEVER pays for
 * these. An unauthenticated call returns the x402 402 challenge passed
 * through (what the endpoint answers + price + payment instructions) so the
 * calling agent or its runtime decides whether to pay. If the caller supplies
 * `payment_signature` (a base64 envelope signed by its own x402 client), we
 * forward it verbatim and return the full paid response. No keys here.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { log } from "../logger.js";
import { err, ok, type ToolResult } from "./shared.js";

export const DATA_TOOLS = [
  "suverse_market_pulse",
  "suverse_wallet_reputation",
  "suverse_token_check",
] as const;

/** The /v1/data endpoints live on the proxy host, not api.suverse.io. */
const DATA_BASE = (process.env.SUVERSE_DATA_BASE_URL ?? "https://proxy.suverse.io").replace(/\/+$/, "");

/** Solana base58 (no 0, O, I, l), 32–44 chars — addresses and mints alike. */
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const REQUEST_TIMEOUT_MS = 30_000;

const paymentSignatureArg = z
  .string()
  .min(1)
  .optional()
  .describe(
    "OPTIONAL base64 x402 payment envelope — the PAYMENT-SIGNATURE header value your " +
      "x402 client (e.g. @suverselabs/x402-client) produced by signing one of the " +
      "`x402.accepts` options from a previous unpaid call. Forwarded verbatim as " +
      "PAYMENT-SIGNATURE + X-PAYMENT; the full paid response is returned. " +
      "This server never signs payments or holds keys for these tools.",
  );

interface DataEndpoint {
  path: string;
  priceUsdc: string;
  whatThisBuys: string;
}

/** Best-effort decode of the settle receipt header (v2 PAYMENT-RESPONSE, v1 X-PAYMENT-RESPONSE). */
function decodeReceipt(res: Response): unknown {
  const h = res.headers.get("payment-response") ?? res.headers.get("x-payment-response");
  if (!h) return undefined;
  try {
    return JSON.parse(Buffer.from(h, "base64").toString("utf8"));
  } catch {
    return undefined;
  }
}

async function callDataEndpoint(
  ep: DataEndpoint,
  body: Record<string, unknown>,
  paymentSignature: string | undefined,
): Promise<ToolResult> {
  const url = `${DATA_BASE}${ep.path}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (paymentSignature) {
    headers["PAYMENT-SIGNATURE"] = paymentSignature;
    headers["X-PAYMENT"] = paymentSignature; // legacy v1 alias, same value
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    return err(`Could not reach ${url}: ${(e as Error).message}. Retry shortly.`);
  }

  if (res.status === 200) {
    const data = await res.json().catch(() => undefined);
    const receipt = decodeReceipt(res);
    log.info("paid data call returned", { path: ep.path, settled: receipt !== undefined });
    return ok({ status: "paid", data, ...(receipt !== undefined ? { payment_receipt: receipt } : {}) });
  }

  if (res.status === 402) {
    const challenge = (await res.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    if (paymentSignature) {
      return err(
        `The payment_signature was not accepted (HTTP 402 again). It may be expired, ` +
          `already used, or signed for a different accept option. Re-sign a fresh ` +
          `challenge: ${JSON.stringify(challenge?.accepts ?? challenge).slice(0, 500)}`,
      );
    }
    return ok({
      status: "payment_required",
      what_this_buys: ep.whatThisBuys,
      price_usdc: ep.priceUsdc,
      endpoint: { method: "POST", url, body },
      x402: challenge, // verbatim challenge: x402Version, resource, accepts (Base / Solana / Cosmos Noble)
      how_to_pay:
        "Sign one of `x402.accepts` with an x402 buyer client (e.g. @suverselabs/x402-client), " +
        "then call this tool again with the same arguments plus `payment_signature` set to the " +
        "base64 header value. All accepts are USDC: Base (eip155:8453), Solana mainnet, Cosmos noble-1.",
    });
  }

  const bodyText = (await res.text().catch(() => "")).slice(0, 300);
  if (res.status === 422) return err(`Endpoint rejected the input (HTTP 422): ${bodyText}`);
  return err(`Unexpected HTTP ${res.status} from ${url}: ${bodyText}`);
}

export function registerDataTools(server: McpServer): void {
  // suverse_market_pulse — $0.10 market regime verdict, no data args.
  server.registerTool(
    "suverse_market_pulse",
    {
      description:
        "Answers: what regime is the crypto market in right now — is smart money accumulating " +
        "or distributing relative to sentiment? The verdict is one of accumulation_on_fear, " +
        "capitulation, confirmed_rally, late_stage_caution with a plain-language summary and " +
        "confidence, built from the fear/greed index crossed with tracked smart-money netflow, " +
        "trending coins checked against smart-money buying, BTC 24h move, and high-conviction " +
        "Polymarket positioning (signals + raw data included). Cost: $0.10 USDC per call via " +
        "x402; this tool does not pay — without payment_signature it returns the price and the " +
        "402 payment instructions. Note: the smart-money/elite-flow layer tracks Solana wallets " +
        "(production); Base coverage is beta.",
      inputSchema: { payment_signature: paymentSignatureArg },
    },
    async (args) => {
      const a = args as { payment_signature?: string };
      return callDataEndpoint(
        {
          path: "/v1/data/crypto-market-pulse",
          priceUsdc: "0.10",
          whatThisBuys:
            "One aggregated market-regime verdict (accumulation_on_fear | capitulation | " +
            "confirmed_rally | late_stage_caution) with all underlying signals and raw data.",
        },
        {},
        a.payment_signature,
      );
    },
  );

  // suverse_wallet_reputation — $0.03 Solana wallet trust verdict.
  server.registerTool(
    "suverse_wallet_reputation",
    {
      description:
        "Answers: can this Solana wallet's trading be trusted or copied? The verdict contains a " +
        "skill tier (elite | skilled | average | weak | unknown), an activity class, " +
        "trading-style flags, 24h/7d/30d trade stats, and recent classified trades — on-chain " +
        "data only. Cost: $0.03 USDC per call via x402; this tool does not pay — without " +
        "payment_signature it returns the price and the 402 payment instructions. Note: skill " +
        "tiers come from SuVerse's elite-flow tracking layer, which exists for Solana only; a " +
        "wallet it has never indexed returns tier 'unknown', not an error.",
      inputSchema: {
        wallet: z.string().describe("Solana wallet address, base58 (32–44 chars)."),
        payment_signature: paymentSignatureArg,
      },
    },
    async (args) => {
      const a = args as { wallet?: string; payment_signature?: string };
      const wallet = (a.wallet ?? "").trim();
      if (!BASE58_RE.test(wallet)) {
        return err(
          `\`wallet\` must be a base58 Solana address: 32–44 characters from the base58 ` +
            `alphabet (no 0, O, I, or l). Got: "${String(a.wallet ?? "").slice(0, 60)}". ` +
            `No request was sent.`,
        );
      }
      return callDataEndpoint(
        {
          path: "/v1/data/wallet-reputation",
          priceUsdc: "0.03",
          whatThisBuys:
            "One wallet-reputation verdict: skill tier, activity class, style flags, " +
            "24h/7d/30d trade stats, recent classified trades.",
        },
        { wallet },
        a.payment_signature,
      );
    },
  );

  // suverse_token_check — $0.05 Solana token enter-safety verdict.
  server.registerTool(
    "suverse_token_check",
    {
      description:
        "Answers: is this Solana token sane to enter right now? The verdict contains a risk " +
        "level with flags from exit cost (a real $500 sell quote), top-10 holder concentration " +
        "with pools excluded, token age, mint/freeze authority checks, 24h momentum, and whether " +
        "tracked elite smart-money wallets bought or sold it in the last 30 days. Cost: $0.05 " +
        "USDC per call via x402; this tool does not pay — without payment_signature it returns " +
        "the price and the 402 payment instructions. Note: the elite-flow signal exists for " +
        "Solana only and most tokens have zero elite touches; the verdict then rests on the " +
        "safety and liquidity checks alone.",
      inputSchema: {
        token: z.string().describe("Solana token mint address, base58 (32–44 chars)."),
        payment_signature: paymentSignatureArg,
      },
    },
    async (args) => {
      const a = args as { token?: string; payment_signature?: string };
      const token = (a.token ?? "").trim();
      if (!BASE58_RE.test(token)) {
        return err(
          `\`token\` must be a base58 Solana mint address: 32–44 characters from the base58 ` +
            `alphabet (no 0, O, I, or l). Got: "${String(a.token ?? "").slice(0, 60)}". ` +
            `No request was sent.`,
        );
      }
      return callDataEndpoint(
        {
          path: "/v1/data/token-check",
          priceUsdc: "0.05",
          whatThisBuys:
            "One token enter-safety verdict: risk level + flags, exit cost, holder " +
            "concentration, authority checks, momentum, elite smart-money touches.",
        },
        { token },
        a.payment_signature,
      );
    },
  );
}
