// test/audit-log.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { AuditLog } from "../src/routing/audit-log.js";
import type { AuditEntry } from "../src/routing/types.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "audit-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    ts: 1776000000,
    source: "agent",
    reason: "test",
    docChecksum: "abc123",
    diffs: [],
    ...overrides,
  };
}

describe("AuditLog.appendEdit + readSince", () => {
  it("appends and reads back a single entry", async () => {
    const log = new AuditLog(tmpDir);
    await log.appendEdit(makeEntry({ ts: 100 }));
    const entries = await log.readSince(0);
    expect(entries).toHaveLength(1);
    expect(entries[0].ts).toBe(100);
  });

  it("readSince filters by cutoffTs (exclusive)", async () => {
    const log = new AuditLog(tmpDir);
    await log.appendEdit(makeEntry({ ts: 100 }));
    await log.appendEdit(makeEntry({ ts: 200 }));
    await log.appendEdit(makeEntry({ ts: 300 }));
    const entries = await log.readSince(150);
    expect(entries.map(e => e.ts)).toEqual([200, 300]);
  });

  it("returns empty array when file is missing", async () => {
    const log = new AuditLog(tmpDir);
    expect(await log.readSince(0)).toEqual([]);
  });

  it("skips malformed lines", async () => {
    const filePath = path.join(tmpDir, "routing-audit.jsonl");
    await fs.writeFile(filePath, '{"ts":100,"source":"agent","docChecksum":"x","diffs":[]}\ngarbage\n{"ts":200,"source":"agent","docChecksum":"y","diffs":[]}\n');
    const log = new AuditLog(tmpDir);
    const entries = await log.readSince(0);
    expect(entries.map(e => e.ts)).toEqual([100, 200]);
  });
});
