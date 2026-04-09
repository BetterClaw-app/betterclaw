import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { EventLog } from "../../src/events.js";
import type { EventLogEntry } from "../../src/types.js";

describe("EventLog", () => {
  let tmpDir: string;
  let log: EventLog;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-events-"));
    log = new EventLog(tmpDir);
  });

  it("starts empty", async () => {
    const entries = await log.readAll();
    expect(entries).toHaveLength(0);
  });

  it("appends and reads entries", async () => {
    const entry: EventLogEntry = {
      event: {
        subscriptionId: "test",
        source: "device.battery",
        data: { level: 0.5 },
        firedAt: 1740000000,
      },
      decision: "push",
      reason: "test",
      timestamp: 1740000000,
    };
    await log.append(entry);
    await log.append({ ...entry, decision: "drop" });

    const entries = await log.readAll();
    expect(entries).toHaveLength(2);
    expect(entries[0].decision).toBe("push");
    expect(entries[1].decision).toBe("drop");
  });

  it("filters by timestamp", async () => {
    const entry: EventLogEntry = {
      event: { subscriptionId: "test", source: "test", data: {}, firedAt: 100 },
      decision: "push",
      reason: "test",
      timestamp: 100,
    };
    await log.append({ ...entry, timestamp: 100 });
    await log.append({ ...entry, timestamp: 200 });
    await log.append({ ...entry, timestamp: 300 });

    const recent = await log.readSince(200);
    expect(recent).toHaveLength(2);
  });
});

function makeEntry(i: number, decision: "push" | "drop" | "stored" = "push"): EventLogEntry {
  return {
    event: {
      subscriptionId: `sub-${i}`,
      source: "device.battery",
      data: { level: 0.5 },
      firedAt: 1740000000 + i,
    },
    decision,
    reason: `reason-${i}`,
    timestamp: 1740000000 + i,
  };
}

describe("EventLog.readRecent", () => {
  let tmpDir: string;
  let log: EventLog;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-ctx-rpc-"));
    log = new EventLog(tmpDir);
  });

  it("returns last N entries when log has more than limit", async () => {
    for (let i = 0; i < 30; i++) {
      await log.append(makeEntry(i));
    }

    const recent = await log.readRecent(10);
    expect(recent).toHaveLength(10);
    expect(recent[0].event.subscriptionId).toBe("sub-20");
    expect(recent[9].event.subscriptionId).toBe("sub-29");
  });

  it("returns all entries when log has fewer than limit", async () => {
    for (let i = 0; i < 5; i++) {
      await log.append(makeEntry(i));
    }

    const recent = await log.readRecent(20);
    expect(recent).toHaveLength(5);
    expect(recent[0].event.subscriptionId).toBe("sub-0");
    expect(recent[4].event.subscriptionId).toBe("sub-4");
  });

  it("returns empty array for empty log", async () => {
    const recent = await log.readRecent(20);
    expect(recent).toHaveLength(0);
  });

  it("uses default limit of 20", async () => {
    for (let i = 0; i < 30; i++) {
      await log.append(makeEntry(i));
    }

    const recent = await log.readRecent();
    expect(recent).toHaveLength(20);
    expect(recent[0].event.subscriptionId).toBe("sub-10");
  });
});

describe("EventLog.rotate", () => {
  let tmpDir: string;
  let log: EventLog;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-rotate-"));
    log = new EventLog(tmpDir);
  });

  it("returns 0 when entry count under MAX_LINES", async () => {
    for (let i = 0; i < 50; i++) {
      await log.append(makeEntry(i));
    }
    const removed = await log.rotate();
    expect(removed).toBe(0);
    // Entries should still be intact
    const all = await log.readAll();
    expect(all).toHaveLength(50);
  });

  it("returns 0 on empty log (missing file)", async () => {
    const removed = await log.rotate();
    expect(removed).toBe(0);
  });

  it("returns 0 on empty log (empty file)", async () => {
    await fs.writeFile(path.join(tmpDir, "events.jsonl"), "", "utf8");
    const removed = await log.rotate();
    expect(removed).toBe(0);
  });
});

describe("EventLog.count", () => {
  let tmpDir: string;
  let log: EventLog;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-count-"));
    log = new EventLog(tmpDir);
  });

  it("returns 0 for missing file", async () => {
    const count = await log.count();
    expect(count).toBe(0);
  });

  it("returns correct count for populated file", async () => {
    for (let i = 0; i < 15; i++) {
      await log.append(makeEntry(i));
    }
    const count = await log.count();
    expect(count).toBe(15);
  });
});
