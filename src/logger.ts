/**
 * stderr-only structured logger.
 *
 * CRITICAL: an MCP stdio server speaks JSON-RPC on **stdout**. Anything written
 * to stdout that isn't a protocol message corrupts the session, so all diagnostic
 * output MUST go to stderr. Never use console.log here.
 */
type Level = "debug" | "info" | "warn" | "error";

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  const line =
    `[${new Date().toISOString()}] ${level.toUpperCase()} suverse-mcp: ${msg}` +
    (fields && Object.keys(fields).length ? ` ${safeJson(fields)}` : "");
  process.stderr.write(line + "\n");
}

/** JSON that never throws (handles BigInt + cycles) so logging can't crash a tool. */
function safeJson(o: unknown): string {
  try {
    return JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  } catch {
    return "[unserializable]";
  }
}

export const log = {
  debug: (m: string, f?: Record<string, unknown>) => emit("debug", m, f),
  info: (m: string, f?: Record<string, unknown>) => emit("info", m, f),
  warn: (m: string, f?: Record<string, unknown>) => emit("warn", m, f),
  error: (m: string, f?: Record<string, unknown>) => emit("error", m, f),
};
