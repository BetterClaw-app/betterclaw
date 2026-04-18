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
    expect(rules.rules.find(r => r.id === "battery-critical")).toBeDefined();
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
