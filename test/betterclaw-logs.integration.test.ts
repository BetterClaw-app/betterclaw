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
});
