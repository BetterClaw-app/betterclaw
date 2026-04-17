import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import zlib from "node:zlib";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { initDiagnosticLogger, type PluginDiagnosticLogger } from "../src/diagnostic-logger.js";
import { noopLogger } from "../src/types.js";
import { handleLogsRpc } from "../src/logs-rpc.js";
import type { RedactedEntry } from "../src/redactor.js";

function entriesOf(r: { entries: string }): RedactedEntry[] {
  const decompressed = zlib.gunzipSync(Buffer.from(r.entries, "base64")).toString("utf8");
  return JSON.parse(decompressed) as RedactedEntry[];
}

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
    const entries = entriesOf(res);
    expect(entries.length).toBe(1);
    const data = JSON.parse(entries[0].data!);
    expect(data.tier).toBe("free");
    expect(data.host).toMatch(/^hmac:/);
  });

  it("drops entries from disabled base categories", async () => {
    dlog.info("plugin.service", "loaded", "m");
    await dlog.flush();
    const res = await handleLogsRpc({ settings: { ...allOn(), lifecycle: false } }, dlog, key);
    expect(entriesOf(res).length).toBe(0);
  });

  it("honors `until` as a window upper bound", async () => {
    dlog.info("plugin.service", "loaded", "early");
    await dlog.flush();
    const upper = Date.now() / 1000 - 3600;
    const res = await handleLogsRpc({ settings: allOn(), until: upper }, dlog, key);
    expect(entriesOf(res).length).toBe(0);
  });

  it("serializes data as JSON string (iOS wire contract)", async () => {
    dlog.info("plugin.service", "loaded", "m", { phase: "init", success: true });
    await dlog.flush();
    const res = await handleLogsRpc({ settings: allOn() }, dlog, key);
    expect(typeof entriesOf(res)[0].data).toBe("string");
  });

  it("uses the supplied key deterministically across calls", async () => {
    dlog.info("plugin.rpc", "ping.received", "ok", { host: "api.example.com" });
    await dlog.flush();
    const suppliedKey = randomBytes(32);
    const r1 = await handleLogsRpc({ settings: allOn() }, dlog, suppliedKey);
    const r2 = await handleLogsRpc({ settings: allOn() }, dlog, suppliedKey);
    const h1 = JSON.parse(entriesOf(r1)[0].data!).host;
    const h2 = JSON.parse(entriesOf(r2)[0].data!).host;
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
    const h1 = JSON.parse(entriesOf(r1)[0].data!).host;
    const h2 = JSON.parse(entriesOf(r2)[0].data!).host;
    expect(h1).not.toBe(h2);
  });

  it("paginates via cursor with no duplicates or gaps", async () => {
    for (let i = 0; i < 7; i++) {
      dlog.info("plugin.service", "loaded", `ev${i}`);
      await new Promise(r => setTimeout(r, 2));
    }
    await dlog.flush();

    // Page 1: limit 3, no cursor → oldest 3 in window.
    const p1 = await handleLogsRpc({ settings: allOn(), limit: 3 }, dlog, key);
    expect(entriesOf(p1).length).toBe(3);
    expect(p1.cursor).toBeTruthy();

    // Page 2.
    const p2 = await handleLogsRpc(
      { settings: allOn(), limit: 3, after: p1.cursor! },
      dlog,
      key,
    );
    expect(entriesOf(p2).length).toBe(3);
    expect(p2.cursor).toBeTruthy();

    // Page 3: last one, cursor null.
    const p3 = await handleLogsRpc(
      { settings: allOn(), limit: 3, after: p2.cursor! },
      dlog,
      key,
    );
    expect(entriesOf(p3).length).toBe(1);
    expect(p3.cursor).toBeNull();

    const messages = [...entriesOf(p1), ...entriesOf(p2), ...entriesOf(p3)].map(e => e.message);
    expect(messages).toEqual(["ev0", "ev1", "ev2", "ev3", "ev4", "ev5", "ev6"]);
  });

  it("pages cleanly through entries at identical timestamps (intra-ts dedup)", async () => {
    // Forge a same-ts run via direct fs write so we control the timestamps.
    await fs.mkdir(logDir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const sharedTs = Math.floor(Date.now() / 1000);
    const lines = [
      { timestamp: sharedTs, level: "info", source: "plugin.service", event: "loaded", message: "same0" },
      { timestamp: sharedTs, level: "info", source: "plugin.service", event: "loaded", message: "same1" },
      { timestamp: sharedTs, level: "info", source: "plugin.service", event: "loaded", message: "same2" },
    ];
    await fs.writeFile(
      path.join(logDir, `diagnostic-${today}.jsonl`),
      lines.map(l => JSON.stringify(l)).join("\n") + "\n",
      "utf-8",
    );

    const p1 = await handleLogsRpc({ settings: allOn(), limit: 1 }, dlog, key);
    expect(entriesOf(p1)[0].message).toBe("same0");
    expect(p1.cursor).toBeTruthy();

    const p2 = await handleLogsRpc(
      { settings: allOn(), limit: 1, after: p1.cursor! },
      dlog,
      key,
    );
    expect(entriesOf(p2)[0].message).toBe("same1");
    expect(p2.cursor).toBeTruthy();

    const p3 = await handleLogsRpc(
      { settings: allOn(), limit: 1, after: p2.cursor! },
      dlog,
      key,
    );
    expect(entriesOf(p3)[0].message).toBe("same2");
    expect(p3.cursor).toBeNull();
  });

  it("entries field is base64-encoded gzipped JSON array", async () => {
    dlog.info("plugin.service", "loaded", "m");
    await dlog.flush();

    const r = await handleLogsRpc({ settings: allOn(), limit: 10 }, dlog, key);

    // Should no longer parse as plain JSON (it's base64 now).
    expect(() => JSON.parse(r.entries)).toThrow();

    // Should decompress + parse cleanly.
    const decompressed = zlib
      .gunzipSync(Buffer.from(r.entries, "base64"))
      .toString("utf8");
    const arr = JSON.parse(decompressed) as RedactedEntry[];
    expect(arr.length).toBe(1);
    expect(arr[0].event).toBe("loaded");
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

import { encodeCursor, decodeCursor } from "../src/logs-rpc.js";

describe("cursor encode/decode", () => {
  it("round-trips {ts, idx}", () => {
    const original = { ts: 1713295000.5, idx: 3 };
    expect(decodeCursor(encodeCursor(original))).toEqual(original);
  });

  it("rejects malformed base64 with INVALID_CURSOR", () => {
    expect(() => decodeCursor("!!!not-base64!!!")).toThrow(/INVALID_CURSOR/);
  });

  it("rejects non-JSON payload with INVALID_CURSOR", () => {
    const bad = Buffer.from("nope").toString("base64");
    expect(() => decodeCursor(bad)).toThrow(/INVALID_CURSOR/);
  });

  it("rejects wrong shape with INVALID_CURSOR", () => {
    const bad = Buffer.from(JSON.stringify({ other: 1 })).toString("base64");
    expect(() => decodeCursor(bad)).toThrow(/INVALID_CURSOR/);
  });
});
