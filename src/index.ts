/** Entry point: load config, wire the x402 client, serve over stdio. */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { ConfigError, loadConfig } from "./config.js";
import { IdempotencyStore } from "./idempotency.js";
import { log } from "./logger.js";
import { buildServer } from "./server.js";
import { createSuverseHttp } from "./x402.js";

async function main(): Promise<void> {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      log.error(e.message);
      process.exit(1);
    }
    throw e;
  }

  const http = createSuverseHttp(cfg);
  const idem = new IdempotencyStore(cfg.idempotencyTtlMs);
  const server = buildServer({ http, cfg, idem });

  log.info("starting suverse-mcp", {
    wallet: http.address,
    apiBase: cfg.apiBase,
    network: cfg.network,
    maxPaymentUsdc: (cfg.maxPaymentMicro / 1_000_000).toFixed(2),
  });

  await server.connect(new StdioServerTransport());
  log.info("connected over stdio — ready");
}

main().catch((e) => {
  log.error("fatal", { error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
