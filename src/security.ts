/**
 * File-path security for `file_path` tool inputs. The server runs on the user's
 * machine with their filesystem access, so a tool that reads an arbitrary path is
 * a real exfiltration risk. We therefore:
 *   1. resolve symlinks (realpath) and require the result inside the user's home
 *      directory (unless SUVERSE_ALLOW_PATHS_OUTSIDE_HOME=true);
 *   2. reject known-sensitive locations (.ssh, .aws, credentials, keys, …);
 *   3. verify the file's MAGIC BYTES match an allowed document type, not just its
 *      extension — so a renamed secret can't slip through.
 * Every resolved path is logged to stderr for audit.
 */
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, resolve, sep } from "node:path";

import type { Config } from "./config.js";
import { log } from "./logger.js";

export class FileSecurityError extends Error {}

/** Directory names that must never appear anywhere in a resolved path. */
const FORBIDDEN_DIRS = new Set([".ssh", ".aws", ".gnupg", ".kube"]);
/** Exact (case-insensitive) basenames that are always rejected. */
const FORBIDDEN_FILES = new Set([
  "credentials", ".env", ".netrc", ".pgpass", ".npmrc", ".git-credentials",
  "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "wallet.dat", "keystore.json",
]);

export type DetectedType =
  | "application/pdf"
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp"
  | "image/tiff";

/** Identify a document by its leading bytes; null if not an allowed type. */
export function detectMediaType(buf: Buffer): DetectedType | null {
  if (buf.length >= 5 && buf.toString("latin1", 0, 5) === "%PDF-") return "application/pdf";
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
    return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 6 && (buf.toString("latin1", 0, 6) === "GIF87a" || buf.toString("latin1", 0, 6) === "GIF89a"))
    return "image/gif";
  if (
    buf.length >= 12 &&
    buf.toString("latin1", 0, 4) === "RIFF" &&
    buf.toString("latin1", 8, 12) === "WEBP"
  )
    return "image/webp";
  if (
    buf.length >= 4 &&
    ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00) ||
      (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a))
  )
    return "image/tiff";
  return null;
}

/** Pure check for a sensitive directory/file in an already-resolved path. Returns
 *  a human reason if forbidden, else null. Exported for direct unit testing. */
export function forbiddenReason(resolved: string): string | null {
  for (const s of resolved.split(sep)) {
    if (FORBIDDEN_DIRS.has(s)) return `sensitive directory ("${s}")`;
  }
  if (FORBIDDEN_FILES.has(basename(resolved).toLowerCase())) {
    return `sensitive file ("${basename(resolved)}")`;
  }
  return null;
}

/** Resolve + authorize a path. Returns the safe absolute path or throws. */
export async function assertSafePath(input: string, cfg: Config): Promise<string> {
  const abs = resolve(input);
  let real: string;
  try {
    real = await realpath(abs);
  } catch {
    throw new FileSecurityError(`File not found or unreadable: ${input}`);
  }

  const home = homedir();
  if (!cfg.allowPathsOutsideHome && real !== home && !real.startsWith(home + sep)) {
    throw new FileSecurityError(
      `Refusing to read "${real}" — outside your home directory (${home}). ` +
        `Set SUVERSE_ALLOW_PATHS_OUTSIDE_HOME=true to override.`,
    );
  }

  const reason = forbiddenReason(real);
  if (reason) throw new FileSecurityError(`Refusing to read a ${reason}: ${real}`);
  return real;
}

export interface SafeFile {
  base64: string;
  mediaType: DetectedType;
  name: string;
}

/** Authorize, read, and content-type-verify a file. Logs the path for audit. */
export async function readSafeFile(input: string, cfg: Config): Promise<SafeFile> {
  const safe = await assertSafePath(input, cfg);
  const buf = await readFile(safe);
  const mediaType = detectMediaType(buf);
  log.info("file_path read", { path: safe, bytes: buf.length, mediaType: mediaType ?? "unknown" });
  if (!mediaType) {
    throw new FileSecurityError(
      `"${basename(safe)}" is not a recognized PDF or image (magic-byte check failed). ` +
        `Only real PDF/PNG/JPEG/GIF/WEBP/TIFF files are accepted.`,
    );
  }
  return { base64: buf.toString("base64"), mediaType, name: basename(safe) };
}
