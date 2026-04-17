import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { PluginDiagnosticLogger, initDiagnosticLogger, _resetWarnDeprecationForTest } from "../src/diagnostic-logger.js";
import { mockLogger, makeTmpDir } from "./helpers.js";
import type { PluginLogEntry, PluginModuleLogger } from "../src/types.js";

describe("PluginDiagnosticLogger", () => {
  let logDir: string;
  let apiLogger: ReturnType<typeof mockLogger>;

  beforeEach(async () => {
    logDir = path.join(await makeTmpDir(), "logs");
    apiLogger = mockLogger();
  });

  describe("core write + read", () => {
    it("writes an entry and reads it back", async () => {
      const dlog = new PluginDiagnosticLogger(logDir, apiLogger);
      dlog.info("plugin.test", "test.event", "hello world", { key: "value" });
      await dlog.flush();
      const { entries } = await dlog.readLogs({ limit: 10 });
      expect(entries).toHaveLength(1);
      expect(entries[0].level).toBe("info");
      expect(entries[0].source).toBe("plugin.test");
      expect(entries[0].event).toBe("test.event");
      expect(entries[0].message).toBe("hello world");
      expect(entries[0].data).toEqual({ key: "value" });
      expect(entries[0].timestamp).toBeGreaterThan(0);
    });

    it("creates log directory on first write", async () => {
      const dlog = new PluginDiagnosticLogger(logDir, apiLogger);
      dlog.info("plugin.test", "test", "msg");
      await dlog.flush();
      const stat = await fs.stat(logDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it("writes to daily file with correct name format", async () => {
      const dlog = new PluginDiagnosticLogger(logDir, apiLogger);
      dlog.info("plugin.test", "test", "msg");
      await dlog.flush();
      const files = await fs.readdir(logDir);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^diagnostic-\d{4}-\d{2}-\d{2}\.jsonl$/);
    });

    it("appends multiple entries to the same daily file", async () => {
      const dlog = new PluginDiagnosticLogger(logDir, apiLogger);
      dlog.info("s", "e", "first");
      dlog.warning("s", "e", "second");
      dlog.error("s", "e", "third");
      await dlog.flush();
      const { entries } = await dlog.readLogs({ limit: 10 });
      expect(entries).toHaveLength(3);
      expect(entries.map((e: PluginLogEntry) => e.level)).toEqual(["info", "warning", "error"]);
    });

    it("omits data field when undefined", async () => {
      const dlog = new PluginDiagnosticLogger(logDir, apiLogger);
      dlog.info("s", "e", "no data");
      await dlog.flush();
      const files = await fs.readdir(logDir);
      const content = await fs.readFile(path.join(logDir, files[0]), "utf-8");
      const parsed = JSON.parse(content.trim());
      expect(parsed.data).toBeUndefined();
    });
  });

  describe("dual-write", () => {
    it("info/warning/error call matching apiLogger method", () => {
      const dlog = new PluginDiagnosticLogger(logDir, apiLogger);
      dlog.info("plugin.test", "e", "info msg");
      dlog.warning("plugin.test", "e", "warn msg");
      dlog.error("plugin.test", "e", "error msg");
      expect(apiLogger.info).toHaveBeenCalledWith("[plugin.test] info msg");
      expect(apiLogger.warn).toHaveBeenCalledWith("[plugin.test] warn msg");
      expect(apiLogger.error).toHaveBeenCalledWith("[plugin.test] error msg");
    });

    it("debug does NOT call apiLogger (file only)", async () => {
      const dlog = new PluginDiagnosticLogger(logDir, apiLogger);
      dlog.debug("plugin.test", "e", "debug msg");
      await dlog.flush();
      expect(apiLogger.info).not.toHaveBeenCalled();
      expect(apiLogger.warn).not.toHaveBeenCalled();
      expect(apiLogger.error).not.toHaveBeenCalled();
      const { entries } = await dlog.readLogs({ limit: 10 });
      expect(entries).toHaveLength(1);
      expect(entries[0].level).toBe("debug");
    });
  });

  describe("scoped handles", () => {
    it("returns PluginModuleLogger with pre-bound source", async () => {
      const dlog = new PluginDiagnosticLogger(logDir, apiLogger);
      const scoped = dlog.scoped("plugin.context");
      scoped.info("save succeeded");
      scoped.warn("save slow");
      scoped.error("save failed");
      await dlog.flush();
      const { entries } = await dlog.readLogs({ limit: 10 });
      expect(entries).toHaveLength(3);
      for (const entry of entries) expect(entry.source).toBe("plugin.context");
      expect(entries[0]).toMatchObject({ level: "info", event: "info", message: "save succeeded" });
      expect(entries[1]).toMatchObject({ level: "warning", event: "warn", message: "save slow" });
      expect(entries[2]).toMatchObject({ level: "error", event: "error", message: "save failed" });
    });

    it("scoped handle dual-writes to apiLogger", () => {
      const dlog = new PluginDiagnosticLogger(logDir, apiLogger);
      const scoped = dlog.scoped("plugin.events");
      scoped.error("append failed: ENOSPC");
      expect(apiLogger.error).toHaveBeenCalledWith("[plugin.events] append failed: ENOSPC");
    });
  });

  describe("readLogs filtering", () => {
    async function seedEntries(dlog: PluginDiagnosticLogger) {
      dlog.debug("plugin.pipeline", "event.received", "debug msg");
      dlog.info("plugin.pipeline", "push.decided", "info pipeline");
      dlog.warning("plugin.context", "warn", "warn context");
      dlog.error("plugin.rpc", "ping.error", "error rpc");
      dlog.info("plugin.pipeline", "push.sent", "another pipeline info");
      await dlog.flush();
    }

    it("filters by minimum level", async () => {
      const dlog = new PluginDiagnosticLogger(logDir, apiLogger);
      await seedEntries(dlog);
      const { entries } = await dlog.readLogs({ level: "warning" });
      expect(entries).toHaveLength(2);
      expect(entries.every((e: PluginLogEntry) => e.level === "warning" || e.level === "error")).toBe(true);
    });

    it("filters by source prefix", async () => {
      const dlog = new PluginDiagnosticLogger(logDir, apiLogger);
      await seedEntries(dlog);
      const { entries } = await dlog.readLogs({ source: "plugin.pipeline" });
      expect(entries).toHaveLength(3);
    });

    it("broad source prefix matches all", async () => {
      const dlog = new PluginDiagnosticLogger(logDir, apiLogger);
      await seedEntries(dlog);
      const { entries } = await dlog.readLogs({ source: "plugin" });
      expect(entries).toHaveLength(5);
    });

    it("filters by since timestamp", async () => {
      const dlog = new PluginDiagnosticLogger(logDir, apiLogger);
      dlog.info("s", "e", "recent");
      await dlog.flush();
      const { entries } = await dlog.readLogs({ since: Date.now() / 1000 + 3600 });
      expect(entries).toHaveLength(0);
    });

    it("respects limit and returns oldest N in window (ASC paging, I2)", async () => {
      const dlog = new PluginDiagnosticLogger(logDir, apiLogger);
      await seedEntries(dlog);
      const { entries, total } = await dlog.readLogs({ limit: 2 });
      expect(entries).toHaveLength(2);
      expect(total).toBe(5);
      // Seeded in order: debug(event.received), info(push.decided), warning, error, info(push.sent).
      // ASC + limit=2 returns the OLDEST two, not the newest two.
      expect(entries[0].event).toBe("event.received");
      expect(entries[1].event).toBe("push.decided");
    });

    it("enforces 50k hard cap on limit", async () => {
      const dlog = new PluginDiagnosticLogger(logDir, apiLogger);
      await seedEntries(dlog);
      const { entries } = await dlog.readLogs({ limit: 100_000 });
      expect(entries.length).toBeLessThanOrEqual(50_000);
    });

    it("returns entries in chronological order", async () => {
      const dlog = new PluginDiagnosticLogger(logDir, apiLogger);
      await seedEntries(dlog);
      const { entries } = await dlog.readLogs({});
      for (let i = 1; i < entries.length; i++) {
        expect(entries[i].timestamp).toBeGreaterThanOrEqual(entries[i - 1].timestamp);
      }
    });

    it("handles empty JSONL file", async () => {
      await fs.mkdir(logDir, { recursive: true });
      await fs.writeFile(path.join(logDir, `diagnostic-${new Date().toISOString().slice(0, 10)}.jsonl`), "", "utf-8");
      const dlog = new PluginDiagnosticLogger(logDir, apiLogger);
      const { entries } = await dlog.readLogs({});
      expect(entries).toHaveLength(0);
    });

    it("reads across multiple daily files", async () => {
      await fs.mkdir(logDir, { recursive: true });
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, "0")}-${String(yesterday.getDate()).padStart(2, "0")}`;
      const oldEntry = { timestamp: yesterday.getTime() / 1000, level: "info", source: "s", event: "e", message: "yesterday" };
      await fs.writeFile(path.join(logDir, `diagnostic-${yStr}.jsonl`), JSON.stringify(oldEntry) + "\n", "utf-8");

      const dlog = new PluginDiagnosticLogger(logDir, apiLogger);
      dlog.info("s", "e", "today");
      await dlog.flush();

      const { entries } = await dlog.readLogs({ since: yesterday.getTime() / 1000 - 1 });
      expect(entries).toHaveLength(2);
      expect(entries[0].message).toBe("yesterday");
      expect(entries[1].message).toBe("today");
    });

    it("ignores non-diagnostic files", async () => {
      const dlog = new PluginDiagnosticLogger(logDir, apiLogger);
      dlog.info("s", "e", "real entry");
      await dlog.flush();
      await fs.writeFile(path.join(logDir, "other-data.json"), '{"ignore":true}\n', "utf-8");
      const { entries } = await dlog.readLogs({});
      expect(entries).toHaveLength(1);
    });

    it("returns empty for nonexistent directory", async () => {
      const dlog = new PluginDiagnosticLogger("/tmp/nonexistent-dlog-dir-xyz", apiLogger);
      const { entries, total } = await dlog.readLogs({});
      expect(entries).toHaveLength(0);
      expect(total).toBe(0);
    });

    it("skips malformed JSON lines", async () => {
      const dlog = new PluginDiagnosticLogger(logDir, apiLogger);
      dlog.info("plugin.test", "e", "good entry");
      await dlog.flush();
      const files = await fs.readdir(logDir);
      await fs.appendFile(path.join(logDir, files[0]), "not valid json\n", "utf-8");
      const { entries } = await dlog.readLogs({});
      expect(entries).toHaveLength(1);
    });

    it("combines level and source filters", async () => {
      const dlog = new PluginDiagnosticLogger(logDir, apiLogger);
      await seedEntries(dlog);
      const { entries } = await dlog.readLogs({ source: "plugin.pipeline", level: "info" });
      expect(entries).toHaveLength(2);
    });
  });

  describe("readLogs cursor pagination (I2, I3)", () => {
    // These tests exercise the ASC + skipUntil contract that Task 4 relies on.
    // Each seeded entry uses dlog.info so timestamps are ~monotonic by call order.

    it("_cursorState is null when the page is not full", async () => {
      const dlog = new PluginDiagnosticLogger(logDir, apiLogger);
      dlog.info("s", "e", "a");
      dlog.info("s", "e", "b");
      await dlog.flush();
      const result = await dlog.readLogs({ limit: 10 });
      expect(result.entries).toHaveLength(2);
      expect(result._cursorState).toBeNull();
    });

    it("_cursorState is populated when a full page has more after it", async () => {
      const dlog = new PluginDiagnosticLogger(logDir, apiLogger);
      dlog.info("s", "e", "a");
      dlog.info("s", "e", "b");
      dlog.info("s", "e", "c");
      dlog.info("s", "e", "d");
      await dlog.flush();
      const result = await dlog.readLogs({ limit: 2 });
      expect(result.entries).toHaveLength(2);
      expect(result._cursorState).not.toBeNull();
      expect(result._cursorState!.ts).toBe(result.entries[1].timestamp);
      expect(typeof result._cursorState!.idx).toBe("number");
      expect(result._cursorState!.idx).toBeGreaterThanOrEqual(1);
    });

    it("_cursorState is null when the page is exactly full with nothing after", async () => {
      const dlog = new PluginDiagnosticLogger(logDir, apiLogger);
      dlog.info("s", "e", "a");
      dlog.info("s", "e", "b");
      await dlog.flush();
      const result = await dlog.readLogs({ limit: 2 });
      expect(result.entries).toHaveLength(2);
      expect(result._cursorState).toBeNull();
    });

    it("skipUntil {ts: lastPageTs, idx: run-count} yields the next oldest-N", async () => {
      const dlog = new PluginDiagnosticLogger(logDir, apiLogger);
      dlog.info("s", "e", "m0");
      dlog.info("s", "e", "m1");
      dlog.info("s", "e", "m2");
      dlog.info("s", "e", "m3");
      dlog.info("s", "e", "m4");
      await dlog.flush();

      const page1 = await dlog.readLogs({ limit: 2 });
      expect(page1.entries.map(e => e.message)).toEqual(["m0", "m1"]);
      expect(page1._cursorState).not.toBeNull();

      const page2 = await dlog.readLogs({ limit: 2, skipUntil: page1._cursorState! });
      expect(page2.entries.map(e => e.message)).toEqual(["m2", "m3"]);

      const page3 = await dlog.readLogs({ limit: 2, skipUntil: page2._cursorState! });
      expect(page3.entries.map(e => e.message)).toEqual(["m4"]);
      expect(page3._cursorState).toBeNull();
    });

    it("skipUntil with idx=0 skips nothing at that ts (consumes zero of the run)", async () => {
      // Forge a file with three entries sharing the same timestamp, and one strictly later.
      await fs.mkdir(logDir, { recursive: true });
      const today = new Date().toISOString().slice(0, 10);
      // Timestamps must be within today's day-bounds so the file-skip range
      // filter keeps the file AND the proactive CURSOR_EXPIRED check (which
      // rejects skip.ts < earliestStartOfDay) does not reject the cursor.
      const startOfDay = new Date(today + "T00:00:00").getTime() / 1000;
      const sharedTs = startOfDay + 1000;
      const lines = [
        { timestamp: sharedTs, level: "info", source: "s", event: "e", message: "a" },
        { timestamp: sharedTs, level: "info", source: "s", event: "e", message: "b" },
        { timestamp: sharedTs, level: "info", source: "s", event: "e", message: "c" },
        { timestamp: sharedTs + 1, level: "info", source: "s", event: "e", message: "d" },
      ];
      await fs.writeFile(
        path.join(logDir, `diagnostic-${today}.jsonl`),
        lines.map(l => JSON.stringify(l)).join("\n") + "\n",
        "utf-8",
      );

      const dlog = new PluginDiagnosticLogger(logDir, apiLogger);
      // idx=0 means we have not consumed any entry at sharedTs yet; all three should appear.
      const result = await dlog.readLogs({ limit: 10, skipUntil: { ts: sharedTs, idx: 0 } });
      expect(result.entries.map(e => e.message)).toEqual(["a", "b", "c", "d"]);
    });

    it("skipUntil with idx=n skips exactly n entries within the same-ts run", async () => {
      await fs.mkdir(logDir, { recursive: true });
      const today = new Date().toISOString().slice(0, 10);
      const startOfDay = new Date(today + "T00:00:00").getTime() / 1000;
      const sharedTs = startOfDay + 2000;
      const lines = [
        { timestamp: sharedTs, level: "info", source: "s", event: "e", message: "a" },
        { timestamp: sharedTs, level: "info", source: "s", event: "e", message: "b" },
        { timestamp: sharedTs, level: "info", source: "s", event: "e", message: "c" },
        { timestamp: sharedTs + 1, level: "info", source: "s", event: "e", message: "d" },
      ];
      await fs.writeFile(
        path.join(logDir, `diagnostic-${today}.jsonl`),
        lines.map(l => JSON.stringify(l)).join("\n") + "\n",
        "utf-8",
      );

      const dlog = new PluginDiagnosticLogger(logDir, apiLogger);
      // idx=2 means we've already consumed 2 entries at sharedTs; only "c" and "d" remain.
      const result = await dlog.readLogs({ limit: 10, skipUntil: { ts: sharedTs, idx: 2 } });
      expect(result.entries.map(e => e.message)).toEqual(["c", "d"]);
    });

    it("multi-hop paging through a same-ts run longer than limit (cumulative idx)", async () => {
      // Regression guard for the cursor-accumulation adjustment: when a same-ts
      // run is longer than `limit`, each subsequent page's outgoing cursor
      // must carry cumulative (not per-page) idx so paging terminates.
      await fs.mkdir(logDir, { recursive: true });
      const today = new Date().toISOString().slice(0, 10);
      const startOfDay = new Date(today + "T00:00:00").getTime() / 1000;
      const sharedTs = startOfDay + 3000;
      const lines = [
        { timestamp: sharedTs, level: "info", source: "s", event: "e", message: "a" },
        { timestamp: sharedTs, level: "info", source: "s", event: "e", message: "b" },
        { timestamp: sharedTs, level: "info", source: "s", event: "e", message: "c" },
        { timestamp: sharedTs, level: "info", source: "s", event: "e", message: "d" },
        { timestamp: sharedTs, level: "info", source: "s", event: "e", message: "e" },
      ];
      await fs.writeFile(
        path.join(logDir, `diagnostic-${today}.jsonl`),
        lines.map(l => JSON.stringify(l)).join("\n") + "\n",
        "utf-8",
      );

      const dlog = new PluginDiagnosticLogger(logDir, apiLogger);

      // Page 1: limit 2, no cursor → [a,b], outgoing cursor {ts, idx:2}.
      const p1 = await dlog.readLogs({ limit: 2 });
      expect(p1.entries.map(e => e.message)).toEqual(["a", "b"]);
      expect(p1._cursorState).toEqual({ ts: sharedTs, idx: 2 });

      // Page 2: skipUntil {ts, 2} → [c,d], outgoing cursor {ts, idx:4}
      // (cumulative — NOT per-page idx:2).
      const p2 = await dlog.readLogs({ limit: 2, skipUntil: p1._cursorState! });
      expect(p2.entries.map(e => e.message)).toEqual(["c", "d"]);
      expect(p2._cursorState).toEqual({ ts: sharedTs, idx: 4 });

      // Page 3: skipUntil {ts, 4} → [e], terminal (cursor null).
      const p3 = await dlog.readLogs({ limit: 2, skipUntil: p2._cursorState! });
      expect(p3.entries.map(e => e.message)).toEqual(["e"]);
      expect(p3._cursorState).toBeNull();
    });

    it("I3: since/until clamp applies before skipUntil; forged skipUntil cannot widen the window", async () => {
      await fs.mkdir(logDir, { recursive: true });
      // Use timestamps within today's date so the day-boundary file-skip keeps the file.
      const today = new Date().toISOString().slice(0, 10);
      const startOfDay = new Date(today + "T00:00:00").getTime() / 1000;
      const tsBelow = startOfDay + 100;
      const tsIn1 = startOfDay + 500;
      const tsIn2 = startOfDay + 600;
      const tsAbove = startOfDay + 900;
      const lines = [
        { timestamp: tsBelow, level: "info", source: "s", event: "e", message: "outside-below" },
        { timestamp: tsIn1, level: "info", source: "s", event: "e", message: "inside-1" },
        { timestamp: tsIn2, level: "info", source: "s", event: "e", message: "inside-2" },
        { timestamp: tsAbove, level: "info", source: "s", event: "e", message: "outside-above" },
      ];
      await fs.writeFile(
        path.join(logDir, `diagnostic-${today}.jsonl`),
        lines.map(l => JSON.stringify(l)).join("\n") + "\n",
        "utf-8",
      );

      const dlog = new PluginDiagnosticLogger(logDir, apiLogger);
      // Forge a skipUntil well before the window. Window is [tsIn1, tsIn2+50].
      // An attacker cannot widen the window by back-dating the cursor —
      // the since/until filter still drops "outside-below" and "outside-above".
      const result = await dlog.readLogs({
        since: tsIn1,
        until: tsIn2 + 50,
        limit: 10,
        skipUntil: { ts: startOfDay, idx: 0 },
      });
      expect(result.entries.map(e => e.message)).toEqual(["inside-1", "inside-2"]);
      expect(result.total).toBe(2);
    });
  });

  describe("rotation", () => {
    it("deletes files older than 7 days", async () => {
      const dlog = new PluginDiagnosticLogger(logDir, apiLogger);
      await fs.mkdir(logDir, { recursive: true });
      await fs.writeFile(path.join(logDir, "diagnostic-2020-01-01.jsonl"), '{"old":true}\n');
      await fs.writeFile(path.join(logDir, "diagnostic-2020-06-15.jsonl"), '{"old":true}\n');
      dlog.info("s", "e", "recent");
      await dlog.flush();
      await dlog.rotate();
      const files = await fs.readdir(logDir);
      expect(files).toHaveLength(1);
    });

    it("keeps files within 7-day window", async () => {
      const dlog = new PluginDiagnosticLogger(logDir, apiLogger);
      await fs.mkdir(logDir, { recursive: true });
      const threeDaysAgo = new Date();
      threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
      const dateStr = `${threeDaysAgo.getFullYear()}-${String(threeDaysAgo.getMonth() + 1).padStart(2, "0")}-${String(threeDaysAgo.getDate()).padStart(2, "0")}`;
      await fs.writeFile(path.join(logDir, `diagnostic-${dateStr}.jsonl`), '{"recent":true}\n');
      await fs.writeFile(path.join(logDir, "diagnostic-2020-01-01.jsonl"), '{"old":true}\n');
      await dlog.rotate();
      const files = await fs.readdir(logDir);
      expect(files).toHaveLength(1);
      expect(files[0]).toContain(dateStr);
    });

    it("handles nonexistent directory gracefully", async () => {
      const dlog = new PluginDiagnosticLogger("/tmp/nonexistent-rotate-xyz", apiLogger);
      await expect(dlog.rotate()).resolves.toBeUndefined();
    });
  });

  describe("rotation mutex (I7)", () => {
    it("readLogs does not observe ENOENT when rotate() fires concurrently", async () => {
      const logger = new PluginDiagnosticLogger(logDir, apiLogger);
      logger.info("test", "ev1", "m");
      await logger.flush();

      // Race: read + rotate simultaneously. With the mutex correctly built,
      // neither throws; readLogs returns a valid {entries, total} shape.
      const readPromise = logger.readLogs({ limit: 100 });
      const rotatePromise = logger.rotate();
      const [read] = await Promise.all([readPromise, rotatePromise]);

      expect(Array.isArray(read.entries)).toBe(true);
    });

    it("serializes concurrent rotations (writer-writer exclusion)", async () => {
      const logger = new PluginDiagnosticLogger(logDir, apiLogger);
      await fs.mkdir(logDir, { recursive: true });
      // Instrument _rotateInner so we can observe concurrent entry.
      // If the mutex fails, maxInFlight rises above 1.
      let inFlight = 0;
      let maxInFlight = 0;
      const origInner = (logger as any)._rotateInner.bind(logger);
      (logger as any)._rotateInner = async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        // Yield so queued rotations get a chance to race us.
        await new Promise((r) => setTimeout(r, 10));
        await origInner();
        inFlight--;
      };
      await Promise.all([logger.rotate(), logger.rotate(), logger.rotate()]);
      expect(maxInFlight).toBe(1);
    });

    it("mutex is safe under rapid rotate->read->rotate->read interleaving", async () => {
      const logger = new PluginDiagnosticLogger(logDir, apiLogger);
      for (let i = 0; i < 5; i++) {
        logger.info("test", `ev${i}`, "m");
      }
      await logger.flush();

      // Fire 4 rotates and 4 reads interleaved, no await between dispatches.
      const ops: Promise<unknown>[] = [];
      for (let i = 0; i < 4; i++) {
        ops.push(logger.rotate());
        ops.push(logger.readLogs({ limit: 100 }));
      }
      const results = await Promise.all(ops);
      // ops[2*k] = rotate (void), ops[2*k+1] = read ({entries, total}).
      for (let i = 0; i < results.length; i += 2) {
        const read = results[i + 1] as { entries: unknown[] };
        expect(Array.isArray(read.entries)).toBe(true);
      }
    });
  });

  describe("circuit breaker", () => {
    it("trips on write failure and logs warning", async () => {
      const badDir = path.join(await makeTmpDir(), "blocker");
      await fs.writeFile(badDir, "not a directory");
      const dlog = new PluginDiagnosticLogger(path.join(badDir, "logs"), apiLogger);
      dlog.info("s", "e", "should fail");
      await dlog.flush();
      expect(apiLogger.info).toHaveBeenCalledTimes(1);
      expect(apiLogger.warn).toHaveBeenCalledWith("[diagnostic-logger] disk write failed, circuit breaker tripped");
      const { entries } = await dlog.readLogs({});
      expect(entries).toHaveLength(0);
    });

    it("stays tripped until rotate resets it", async () => {
      const badDir = path.join(await makeTmpDir(), "blocker");
      await fs.writeFile(badDir, "not a directory");
      const dlog = new PluginDiagnosticLogger(path.join(badDir, "logs"), apiLogger);
      dlog.info("s", "e", "trigger failure");
      await dlog.flush();

      dlog.info("s", "e", "skipped");
      await dlog.flush();
      expect(apiLogger.info).toHaveBeenCalledTimes(2);

      const goodDir = path.join(await makeTmpDir(), "logs");
      await fs.mkdir(goodDir, { recursive: true });
      (dlog as any).logDir = goodDir;
      (dlog as any).dirEnsured = false;
      await dlog.rotate();

      dlog.info("s", "e", "works now");
      await dlog.flush();
      const result = await dlog.readLogs({});
      expect(result.entries).toHaveLength(1);
    });
  });
});

describe("betterclaw.logs RPC response shape", () => {
  let dlog: PluginDiagnosticLogger;

  beforeEach(async () => {
    const logDir = path.join(await makeTmpDir(), "logs");
    dlog = new PluginDiagnosticLogger(logDir, mockLogger());
    dlog.info("plugin.pipeline", "push.sent", "test event", { subscriptionId: "test" });
    dlog.warning("plugin.rpc", "ping.error", "test warning");
    await dlog.flush();
  });

  it("returns entries and total matching RPC response shape", async () => {
    const result = await dlog.readLogs({ level: "warning", limit: 10 });
    expect(result).toHaveProperty("entries");
    expect(result).toHaveProperty("total");
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].level).toBe("warning");
  });

  it("source prefix filter works", async () => {
    const result = await dlog.readLogs({ source: "plugin.pipeline" });
    expect(result.entries).toHaveLength(1);
  });

  it("returns empty for no matches", async () => {
    const result = await dlog.readLogs({ source: "nonexistent" });
    expect(result.entries).toHaveLength(0);
    expect(result.total).toBe(0);
  });
});

describe("diagnostic logger — 6-level taxonomy", () => {
  it("emits notice / warning / critical with correct level strings", async () => {
    const dir = path.join(await makeTmpDir(), "dlog-levels");
    const calls: string[] = [];
    const capture: PluginModuleLogger = {
      info: (m) => calls.push(`info:${m}`),
      warn: (m) => calls.push(`warn:${m}`),
      error: (m) => calls.push(`error:${m}`),
    };
    const dlog = initDiagnosticLogger(dir, capture);
    dlog.notice("plugin.service", "t.notice", "n");
    dlog.warning("plugin.service", "t.warning", "w");
    dlog.critical("plugin.service", "t.critical", "c");
    await dlog.flush();
    const files = (await fs.readdir(dir)).sort();
    const content = await fs.readFile(path.join(dir, files[0]), "utf-8");
    const levels = content.trim().split("\n").map(l => JSON.parse(l).level);
    expect(levels).toEqual(["notice", "warning", "critical"]);
    // SDK shim: notice → info, warning → warn, critical → error
    expect(calls).toEqual([
      "info:[plugin.service] n",
      "warn:[plugin.service] w",
      "error:[plugin.service] c",
    ]);
  });

  it(".warn() is a deprecation shim that routes to warning and emits a one-shot console.warn", async () => {
    _resetWarnDeprecationForTest();
    const dir = path.join(await makeTmpDir(), "dlog-warn-shim");
    const sdkCalls: string[] = [];
    const capture: PluginModuleLogger = {
      info: () => {}, warn: (m) => sdkCalls.push(m), error: () => {},
    };
    const origConsoleWarn = console.warn;
    const consoleCalls: unknown[][] = [];
    console.warn = (...args: unknown[]) => { consoleCalls.push(args); };
    try {
      const dlog = initDiagnosticLogger(dir, capture);
      dlog.warn("plugin.service", "t.warn", "x");
      dlog.warn("plugin.service", "t.warn", "y");
      await dlog.flush();
      expect(sdkCalls.length).toBe(2);
      expect(consoleCalls.length).toBe(1);
      expect(String(consoleCalls[0][0])).toMatch(/deprecated/i);
    } finally {
      console.warn = origConsoleWarn;
    }
  });
});
