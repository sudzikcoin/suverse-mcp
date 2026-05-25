/** Environment configuration, parsed + validated once at startup. */

export interface Config {
  /** 0x-prefixed 32-byte EVM private key that signs Base USDC payments. */
  privateKey: `0x${string}`;
  /** SuVerse API base URL, no trailing slash. */
  apiBase: string;
  /** Hard per-call payment ceiling, in micro-USDC (1 USDC = 1_000_000). */
  maxPaymentMicro: number;
  /** Optional Base JSON-RPC URL for balance reads; undefined => viem default. */
  rpcUrl?: string;
  /** USDC contract on Base mainnet (6 decimals). */
  usdcAddress: `0x${string}`;
  /** x402 v2 CAIP-2 network id we pay on (Base mainnet). */
  network: string;
  /** Allow file_path inputs resolving outside the user's home directory. */
  allowPathsOutsideHome: boolean;
  /** Client-side idempotency cache TTL in ms. */
  idempotencyTtlMs: number;
}

export class ConfigError extends Error {}

const DEFAULT_USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

function parseUsdcToMicro(raw: string | undefined, fallbackMicro: number): number {
  if (!raw || !raw.trim()) return fallbackMicro;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ConfigError(`SUVERSE_MAX_PAYMENT_USDC must be a positive number, got "${raw}"`);
  }
  return Math.round(n * 1_000_000);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const pk = (env.SUVERSE_BASE_PRIVATE_KEY || "").trim();
  if (!pk) {
    throw new ConfigError(
      "SUVERSE_BASE_PRIVATE_KEY is required. Add it under mcpServers.suverse.env in " +
        "claude_desktop_config.json (a 0x-prefixed Base private key).",
    );
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    throw new ConfigError(
      "SUVERSE_BASE_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string (66 chars).",
    );
  }

  const ttlRaw = Number(env.SUVERSE_IDEMPOTENCY_TTL_MS);
  return {
    privateKey: pk as `0x${string}`,
    apiBase: (env.SUVERSE_API_BASE || "https://api.suverse.io").replace(/\/+$/, ""),
    maxPaymentMicro: parseUsdcToMicro(env.SUVERSE_MAX_PAYMENT_USDC, 600_000),
    rpcUrl: env.SUVERSE_BASE_RPC_URL?.trim() || undefined,
    usdcAddress: (env.SUVERSE_USDC_ADDRESS?.trim() || DEFAULT_USDC_BASE) as `0x${string}`,
    network: env.SUVERSE_X402_NETWORK?.trim() || "eip155:8453",
    allowPathsOutsideHome: (env.SUVERSE_ALLOW_PATHS_OUTSIDE_HOME || "").toLowerCase() === "true",
    idempotencyTtlMs: Number.isFinite(ttlRaw) && ttlRaw > 0 ? ttlRaw : 120_000,
  };
}
