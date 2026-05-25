/** Shared plumbing for tool handlers: DI context, file resolution, the paid-call
 *  wrapper (idempotency + payment + formatting), and error mapping. */
import type { Config } from "../config.js";
import type { EndpointSpec } from "../endpoints.js";
import { microToUsd } from "../endpoints.js";
import type { IdempotencyStore } from "../idempotency.js";
import { log } from "../logger.js";
import { FileSecurityError, readSafeFile } from "../security.js";
import { NoBasePaymentOption, PaymentCapError, type SuverseHttp } from "../x402.js";

export interface ToolContext {
  http: SuverseHttp;
  cfg: Config;
  idem: IdempotencyStore;
}

/** MCP CallToolResult shape (text content). The index signature mirrors the SDK's
 *  CallToolResult so handlers returning this type are directly assignable. */
export interface ToolResult {
  [x: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export class ToolInputError extends Error {}

export function ok(data: unknown): ToolResult {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text }] };
}

export function err(message: string): ToolResult {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

/** Append the published price to a tool description so cost is always visible. */
export function priced(spec: EndpointSpec): string {
  return `${spec.description} Cost: $${microToUsd(spec.priceMicro)} USDC per call.`;
}

/** Map a `file_path` arg onto the endpoint's body fields (magic-byte verified). */
async function resolveBody(
  spec: EndpointSpec,
  args: Record<string, unknown>,
  cfg: Config,
): Promise<Record<string, unknown>> {
  const { file_path, ...rest } = args;
  const body: Record<string, unknown> = { ...rest };
  if (file_path == null || file_path === "") return body;
  if (typeof file_path !== "string") throw new ToolInputError("file_path must be a string.");
  if (!spec.file) throw new ToolInputError(`${spec.tool} does not accept file_path.`);

  const f = await readSafeFile(file_path, cfg);
  if (spec.file.filesArray) {
    body.files = [{ data: f.base64, media_type: f.mediaType, name: f.name }];
  } else if (f.mediaType === "application/pdf" && spec.file.pdfField) {
    body[spec.file.pdfField] = f.base64;
  } else if (f.mediaType.startsWith("image/") && spec.file.imageField) {
    body[spec.file.imageField] = f.base64;
  } else {
    const accepts = [spec.file.pdfField && "PDF", spec.file.imageField && "image"]
      .filter(Boolean)
      .join(" or ");
    throw new ToolInputError(`${spec.tool} accepts ${accepts} files; got ${f.mediaType}.`);
  }
  return body;
}

/** Run a paid tool: client idempotency → resolve file → pay → cache → format. */
export async function callPaid(
  ctx: ToolContext,
  spec: EndpointSpec,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    const { key, nonce, cached } = ctx.idem.begin(spec.tool, args);
    if (cached !== undefined) {
      log.info("idempotent client cache hit (no payment)", { tool: spec.tool });
      return ok(cached);
    }
    let body: Record<string, unknown>;
    try {
      body = await resolveBody(spec, args, ctx.cfg);
    } catch (e) {
      ctx.idem.release(key);
      throw e;
    }

    let result;
    try {
      result = await ctx.http.paidRequest(spec.path, body, spec.priceMicro, nonce);
    } catch (e) {
      ctx.idem.release(key); // let a real retry through
      throw e;
    }
    ctx.idem.store(key, result.data);
    return ok(result.data);
  } catch (e) {
    return err(mapError(e, ctx.cfg));
  }
}

/** Turn any thrown error into a clear, actionable message for Claude/the user. */
export function mapError(e: unknown, cfg: Config): string {
  if (e instanceof PaymentCapError) return e.message;
  if (e instanceof NoBasePaymentOption) {
    return `${e.message} (The server must advertise a Base accept — check that dual-chain is enabled.)`;
  }
  if (e instanceof FileSecurityError || e instanceof ToolInputError) return e.message;

  // axios-style error.
  const ax = e as { response?: { status?: number; data?: unknown }; code?: string; message?: string };
  if (ax?.response) {
    const status = ax.response.status;
    const data = ax.response.data as { error?: string } | undefined;
    const detail = data?.error ? `: ${data.error}` : "";
    if (status === 402) {
      return `Payment could not be completed (HTTP 402)${detail}. Check your Base USDC balance ` +
        `with suverse_balance — you may have insufficient funds.`;
    }
    if (status === 503) return `SuVerse temporarily unavailable (HTTP 503)${detail}. Retry shortly.`;
    return `SuVerse API error (HTTP ${status})${detail}.`;
  }
  if (ax?.code === "ECONNABORTED") return "Request timed out reaching SuVerse. Retry shortly.";
  if (ax?.code || /network|ENOTFOUND|ECONN/i.test(ax?.message ?? "")) {
    return `Could not reach SuVerse at ${cfg.apiBase} (network error). ${ax?.message ?? ""}`.trim();
  }
  const msg = ax?.message ?? String(e);
  if (/insufficient|balance|fund/i.test(msg)) {
    return `${msg} — check your Base USDC balance with suverse_balance.`;
  }
  return msg;
}
