import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { initDiagnosticLogger, type PluginDiagnosticLogger } from "../src/diagnostic-logger.js";
import { noopLogger } from "../src/types.js";
import { handleLogsRpc } from "../src/logs-rpc.js";

function allOn() {
  return {
    connection: true, heartbeat: true, commands: true, dns: true,
    lifecycle: true, battery: true,
    subscriptions: true, health: true, location: true, geofence: true,
  };
}

describe("betterclaw.logs RPC", () => {
  let logDir: string;
  let dlog: PluginDiagnosticLogger;
  const key = randomBytes(32);

  beforeEach(async () => {
    logDir = await fs.mkdtemp(path.join(os.tmpdir(), "logs-rpc-"));
    dlog = initDiagnosticLogger(logDir, noopLogger);
  });

  it("returns redacted entries with schemaVersion and manifestVersion", async () => {
    dlog.info("plugin.rpc", "ping.received", "ok", { tier: "free", host: "api.x.com" });
    await dlog.flush();
    const res = await handleLogsRpc({ settings: allOn() }, dlog, key);
    expect(res.schemaVersion).toBe(1);
    expect(res.manifestVersion).toBeGreaterThan(0);
    expect(res.entries.length).toBe(1);
    const data = JSON.parse(res.entries[0].data!);
    expect(data.tier).toBe("free");
    expect(data.host).toMatch(/^hmac:/);
  });

  it("drops entries from disabled base categories", async () => {
    dlog.info("plugin.service", "loaded", "m");
    await dlog.flush();
    const res = await handleLogsRpc({ settings: { ...allOn(), lifecycle: false } }, dlog, key);
    expect(res.entries.length).toBe(0);
  });

  it("returns newest entries first when limit hit; truncated=true", async () => {
    for (let i = 0; i < 5; i++) {
      dlog.info("plugin.service", "loaded", `m${i}`);
      await new Promise(r => setTimeout(r, 5));
    }
    await dlog.flush();
    const res = await handleLogsRpc({ settings: allOn(), limit: 3 }, dlog, key);
    expect(res.entries.length).toBe(3);
    expect(res.truncated).toBe(true);
    const msgs = res.entries.map(e => e.message);
    expect(msgs).toContain("m4");
    expect(msgs).toContain("m3");
    expect(msgs).toContain("m2");
    expect(msgs).not.toContain("m0");
    expect(msgs).not.toContain("m1");
  });

  it("honors `until` as a window upper bound", async () => {
    dlog.info("plugin.service", "loaded", "early");
    await dlog.flush();
    const upper = Date.now() / 1000 - 3600;
    const res = await handleLogsRpc({ settings: allOn(), until: upper }, dlog, key);
    expect(res.entries.length).toBe(0);
  });

  it("serializes data as JSON string (iOS wire contract)", async () => {
    dlog.info("plugin.service", "loaded", "m", { phase: "init", success: true });
    await dlog.flush();
    const res = await handleLogsRpc({ settings: allOn() }, dlog, key);
    expect(typeof res.entries[0].data).toBe("string");
  });

  it("uses the supplied key deterministically across calls", async () => {
    dlog.info("plugin.rpc", "ping.received", "ok", { host: "api.example.com" });
    await dlog.flush();
    const suppliedKey = randomBytes(32);
    const r1 = await handleLogsRpc({ settings: allOn() }, dlog, suppliedKey);
    const r2 = await handleLogsRpc({ settings: allOn() }, dlog, suppliedKey);
    const h1 = JSON.parse(r1.entries[0].data!).host;
    const h2 = JSON.parse(r2.entries[0].data!).host;
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^hmac:/);
  });

  it("produces a different hash when the key differs", async () => {
    dlog.info("plugin.rpc", "ping.received", "ok", { host: "api.example.com" });
    await dlog.flush();
    const k1 = randomBytes(32);
    const k2 = randomBytes(32);
    const r1 = await handleLogsRpc({ settings: allOn() }, dlog, k1);
    const r2 = await handleLogsRpc({ settings: allOn() }, dlog, k2);
    const h1 = JSON.parse(r1.entries[0].data!).host;
    const h2 = JSON.parse(r2.entries[0].data!).host;
    expect(h1).not.toBe(h2);
  });
});

import { resolveAnonymizationKey } from "../src/logs-rpc.js";
import { Buffer } from "node:buffer";

describe("resolveAnonymizationKey", () => {
  const fallback = randomBytes(32);

  it("returns fallback when anonymizationKey absent", () => {
    const r = resolveAnonymizationKey({ settings: allOn() }, fallback);
    expect("key" in r && r.key.equals(fallback)).toBe(true);
  });

  it("returns supplied key when valid 32-byte base64", () => {
    const supplied = randomBytes(32);
    const r = resolveAnonymizationKey(
      { settings: allOn(), anonymizationKey: supplied.toString("base64") },
      fallback,
    );
    expect("key" in r && r.key.equals(supplied)).toBe(true);
  });

  it("rejects short key with INVALID_KEY", () => {
    const r = resolveAnonymizationKey(
      { settings: allOn(), anonymizationKey: Buffer.alloc(16).toString("base64") },
      fallback,
    );
    expect("error" in r && r.error.code).toBe("INVALID_KEY");
  });

  it("rejects long key with INVALID_KEY", () => {
    const r = resolveAnonymizationKey(
      { settings: allOn(), anonymizationKey: Buffer.alloc(64).toString("base64") },
      fallback,
    );
    expect("error" in r && r.error.code).toBe("INVALID_KEY");
  });

  it("INVALID_KEY error never echoes the submitted key in its message", () => {
    const suspiciousKey = Buffer.alloc(16, 0xab).toString("base64");
    const r = resolveAnonymizationKey(
      { settings: allOn(), anonymizationKey: suspiciousKey },
      fallback,
    );
    expect("error" in r).toBe(true);
    if ("error" in r) {
      expect(r.error.message).not.toContain(suspiciousKey);
      expect(JSON.stringify(r.error)).not.toContain(suspiciousKey);
    }
  });

  it("rejects non-string anonymizationKey with INVALID_KEY and never echoes the submitted value", () => {
    const suspiciousValue = 12345;
    // Type cast: the runtime contract accepts `unknown` from RPC params;
    // the static type is only useful at compile time.
    const r = resolveAnonymizationKey(
      { settings: allOn(), anonymizationKey: suspiciousValue as unknown as string },
      randomBytes(32),
    );
    expect("error" in r).toBe(true);
    if ("error" in r) {
      expect(r.error.code).toBe("INVALID_KEY");
      expect(r.error.message).not.toContain(String(suspiciousValue));
      expect(JSON.stringify(r.error)).not.toContain(String(suspiciousValue));
    }
  });
});
