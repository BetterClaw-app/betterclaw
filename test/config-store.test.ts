// test/config-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { RoutingConfigStore } from "../src/routing/config-store.js";
import { AuditLog } from "../src/routing/audit-log.js";

let tmpDir: string;

beforeEach(async () => { tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rcs-test-")); });
afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

describe("RoutingConfigStore.load — first run", () => {
  it("writes shipped defaults and a source:default audit entry when routing-rules.json is missing", async () => {
    const log = new AuditLog(tmpDir);
    const store = await RoutingConfigStore.load(tmpDir, log);
    const rules = store.getRules();
    expect(rules.version).toBe(1);
    expect(rules.rules.find(r => r.id === "geofence-enter-default")).toBeDefined();
    expect(rules.rules[rules.rules.length - 1].id).toBe("default-drop");

    // File created
    const filePath = path.join(tmpDir, "routing-rules.json");
    expect(await fileExists(filePath)).toBe(true);

    // Audit entry recorded
    const entries = await log.readSince(0);
    expect(entries).toHaveLength(1);
    expect(entries[0].source).toBe("default");
  });

  it("loads existing config without writing an audit entry when lastknown matches", async () => {
    // Pre-seed
    const log = new AuditLog(tmpDir);
    const first = await RoutingConfigStore.load(tmpDir, log);
    const checksumAfterBootstrap = first.getChecksum();

    // Reload
    const log2 = new AuditLog(tmpDir);
    const store = await RoutingConfigStore.load(tmpDir, log2);
    expect(store.getChecksum()).toBe(checksumAfterBootstrap);

    const entries = await log2.readSince(0);
    expect(entries).toHaveLength(1); // only the original bootstrap entry
  });

  it("detects manual edit and appends source:user audit entry on load", async () => {
    const log = new AuditLog(tmpDir);
    await RoutingConfigStore.load(tmpDir, log);

    // User manually edits the file (plugin is not running)
    const filePath = path.join(tmpDir, "routing-rules.json");
    const config = JSON.parse(await fs.readFile(filePath, "utf8"));
    config.quietHours.start = "22:00";
    await fs.writeFile(filePath, JSON.stringify(config, null, 2));

    // Reload — detection should fire
    const log2 = new AuditLog(tmpDir);
    const store = await RoutingConfigStore.load(tmpDir, log2);
    expect(store.getRules().quietHours.start).toBe("22:00");

    const entries = await log2.readSince(0);
    const userEntries = entries.filter(e => e.source === "user");
    expect(userEntries).toHaveLength(1);
    expect(userEntries[0].diffs.some(d => d.path === "/quietHours/start")).toBe(true);
    expect(userEntries[0].expiresAt).toBeGreaterThan(Date.now() / 1000);
  });

  it("falls back to in-memory defaults when file is corrupt (no overwrite)", async () => {
    const filePath = path.join(tmpDir, "routing-rules.json");
    await fs.writeFile(filePath, "{ not valid JSON");

    const log = new AuditLog(tmpDir);
    const store = await RoutingConfigStore.load(tmpDir, log);
    expect(store.getRules().rules.find(r => r.id === "default-drop")).toBeDefined();

    // File preserved for forensics
    expect(await fs.readFile(filePath, "utf8")).toBe("{ not valid JSON");
  });
});

async function fileExists(p: string): Promise<boolean> {
  try { await fs.stat(p); return true; } catch { return false; }
}

describe("RoutingConfigStore.applyPatch", () => {
  it("applies a patch, writes the new config, and appends an agent audit entry", async () => {
    const log = new AuditLog(tmpDir);
    const store = await RoutingConfigStore.load(tmpDir, log);
    const result = await store.applyPatch(
      [{ op: "replace", path: "/quietHours/start", value: "22:00" }],
      "agent",
      "user asked to start quiet hours at 10pm",
    );
    expect(result.applied).toHaveLength(1);
    expect(result.dropped).toHaveLength(0);
    expect(store.getRules().quietHours.start).toBe("22:00");

    // File + lastknown updated
    const filePath = path.join(tmpDir, "routing-rules.json");
    const written = JSON.parse(await fs.readFile(filePath, "utf8"));
    expect(written.quietHours.start).toBe("22:00");

    // Audit entry appended
    const entries = await log.readSince(0);
    const agentEntries = entries.filter(e => e.source === "agent");
    expect(agentEntries).toHaveLength(1);
    expect(agentEntries[0].reason).toBe("user asked to start quiet hours at 10pm");
  });

  it("drops ops targeting locked keys, still applies others", async () => {
    const log = new AuditLog(tmpDir);
    const store = await RoutingConfigStore.load(tmpDir, log);
    // Simulate a user lock
    await log.appendEdit({
      ts: Math.floor(Date.now() / 1000) - 100,
      source: "user",
      docChecksum: "xxx",
      diffs: [{ path: "/quietHours/start", from: "23:00", to: "22:30" }],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    const result = await store.applyPatch(
      [
        { op: "replace", path: "/quietHours/start", value: "21:00" },  // locked
        { op: "replace", path: "/quietHours/end", value: "08:00" },    // allowed
      ],
      "learner",
      "daily tuning",
    );
    expect(result.applied.map(a => a.path)).toEqual(["/quietHours/end"]);
    expect(result.dropped.map(d => d.op.path)).toEqual(["/quietHours/start"]);
  });

  it("serializes concurrent applyPatch calls", async () => {
    const log = new AuditLog(tmpDir);
    const store = await RoutingConfigStore.load(tmpDir, log);
    const results = await Promise.all([
      store.applyPatch([{ op: "add", path: "/rules/-", value: { id: "r1", match: "*", action: "push", explicit: true } }], "agent", "a"),
      store.applyPatch([{ op: "add", path: "/rules/-", value: { id: "r2", match: "*", action: "push", explicit: true } }], "agent", "b"),
    ]);
    expect(results[0].applied).toHaveLength(1);
    expect(results[1].applied).toHaveLength(1);
    const ids = store.getRules().rules.map(r => r.id);
    expect(ids).toContain("r1");
    expect(ids).toContain("r2");
  });
});
