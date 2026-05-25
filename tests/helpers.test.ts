import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadConfig, ConfigError } from "../src/config.js";
import { ENDPOINTS, PAID_TOOLS, microToUsd } from "../src/endpoints.js";
import { IdempotencyStore, canonical } from "../src/idempotency.js";
import {
  assertSafePath,
  detectMediaType,
  forbiddenReason,
  readSafeFile,
  FileSecurityError,
} from "../src/security.js";

const PK = ("0x" + "1".repeat(64)) as `0x${string}`;
const cfg = loadConfig({ SUVERSE_BASE_PRIVATE_KEY: PK });

describe("config", () => {
  it("rejects a missing key", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
  });
  it("rejects a malformed key", () => {
    expect(() => loadConfig({ SUVERSE_BASE_PRIVATE_KEY: "nope" })).toThrow(ConfigError);
  });
  it("defaults the cap to 0.60 USDC", () => {
    expect(cfg.maxPaymentMicro).toBe(600_000);
  });
  it("parses a custom cap to micro", () => {
    expect(loadConfig({ SUVERSE_BASE_PRIVATE_KEY: PK, SUVERSE_MAX_PAYMENT_USDC: "0.25" }).maxPaymentMicro).toBe(250_000);
  });
});

describe("endpoints table", () => {
  it("has exactly 12 paid endpoints", () => {
    expect(PAID_TOOLS.length).toBe(12);
  });
  it("truck_route ($0.50) is under the 0.60 cap", () => {
    expect(ENDPOINTS.freight_truck_route!.priceMicro).toBeLessThanOrEqual(cfg.maxPaymentMicro);
  });
  it("formats micro to USD", () => {
    expect(microToUsd(500_000)).toBe("0.50");
    expect(microToUsd(5_000)).toBe("0.005000");
  });
});

describe("magic-byte detection", () => {
  it("detects PDF", () => {
    expect(detectMediaType(Buffer.from("%PDF-1.7\n..."))).toBe("application/pdf");
  });
  it("detects PNG", () => {
    expect(detectMediaType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
  });
  it("detects JPEG", () => {
    expect(detectMediaType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
  });
  it("returns null for text", () => {
    expect(detectMediaType(Buffer.from("just some text"))).toBeNull();
  });
});

describe("path security (pure)", () => {
  it("flags .ssh dir", () => {
    expect(forbiddenReason(join(homedir(), ".ssh", "id_rsa"))).toMatch(/sensitive directory/);
  });
  it("flags credentials file", () => {
    expect(forbiddenReason(join(homedir(), "project", "credentials"))).toMatch(/sensitive file/);
  });
  it("flags .aws", () => {
    expect(forbiddenReason(join(homedir(), ".aws", "config"))).toMatch(/sensitive/);
  });
  it("allows a normal doc", () => {
    expect(forbiddenReason(join(homedir(), "Downloads", "load.pdf"))).toBeNull();
  });
});

describe("path security (filesystem)", () => {
  it("rejects a path outside home", async () => {
    const dir = mkdtempSync(join(tmpdir(), "suverse-out-"));
    const p = join(dir, "x.pdf");
    writeFileSync(p, "%PDF-1.4\n");
    try {
      await expect(assertSafePath(p, cfg)).rejects.toBeInstanceOf(FileSecurityError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads a real PDF inside home + verifies magic bytes", async () => {
    const dir = mkdtempSync(join(homedir(), ".suverse-test-"));
    const p = join(dir, "doc.pdf");
    writeFileSync(p, "%PDF-1.7\nhello");
    try {
      const f = await readSafeFile(p, cfg);
      expect(f.mediaType).toBe("application/pdf");
      expect(Buffer.from(f.base64, "base64").toString("latin1")).toContain("%PDF");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a renamed non-document inside home", async () => {
    const dir = mkdtempSync(join(homedir(), ".suverse-test-"));
    const p = join(dir, "secret.pdf");
    writeFileSync(p, "PRIVATE KEY-----BEGIN");
    try {
      await expect(readSafeFile(p, cfg)).rejects.toBeInstanceOf(FileSecurityError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("canonical json", () => {
  it("is order-independent", () => {
    expect(canonical({ b: 1, a: 2 })).toBe(canonical({ a: 2, b: 1 }));
  });
  it("differs for different values", () => {
    expect(canonical({ a: 1 })).not.toBe(canonical({ a: 2 }));
  });
});

describe("idempotency store", () => {
  it("returns a stable nonce + caches the response", () => {
    const s = new IdempotencyStore(60_000);
    const first = s.begin("gov_query", { service: "x" });
    expect(first.cached).toBeUndefined();
    s.store(first.key, { ok: true });
    const second = s.begin("gov_query", { service: "x" });
    expect(second.nonce).toBe(first.nonce);
    expect(second.cached).toEqual({ ok: true });
  });
  it("treats different args as a new call", () => {
    const s = new IdempotencyStore(60_000);
    const a = s.begin("gov_query", { service: "x" });
    const b = s.begin("gov_query", { service: "y" });
    expect(b.nonce).not.toBe(a.nonce);
  });
  it("release lets a retry through", () => {
    const s = new IdempotencyStore(60_000);
    const a = s.begin("gov_query", { service: "x" });
    s.release(a.key);
    const b = s.begin("gov_query", { service: "x" });
    expect(b.nonce).not.toBe(a.nonce);
  });
});
