import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { PluginDiagnosticLogger, initDiagnosticLogger } from "../src/diagnostic-logger.js";
import { mockLogger, makeTmpDir } from "./helpers.js";
import type { PluginLogEntry } from "../src/types.js";

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
      dlog.warn("s", "e", "second");
      dlog.error("s", "e", "third");
      await dlog.flush();
      const { entries } = await dlog.readLogs({ limit: 10 });
      expect(entries).toHaveLength(3);
      expect(entries.map((e: PluginLogEntry) => e.level)).toEqual(["info", "warn", "error"]);
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
    it("info/warn/error call matching apiLogger method", () => {
      const dlog = new PluginDiagnosticLogger(logDir, apiLogger);
      dlog.info("plugin.test", "e", "info msg");
      dlog.warn("plugin.test", "e", "warn msg");
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
      expect(entries[1]).toMatchObject({ level: "warn", event: "warn", message: "save slow" });
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
      dlog.warn("plugin.context", "warn", "warn context");
      dlog.error("plugin.rpc", "ping.error", "error rpc");
      dlog.info("plugin.pipeline", "push.sent", "another pipeline info");
      await dlog.flush();
    }

    it("filters by minimum level", async () => {
      const dlog = new PluginDiagnosticLogger(logDir, apiLogger);
      await seedEntries(dlog);
      const { entries } = await dlog.readLogs({ level: "warn" });
      expect(entries).toHaveLength(2);
      expect(entries.every((e: PluginLogEntry) => e.level === "warn" || e.level === "error")).toBe(true);
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

    it("respects limit and returns most recent", async () => {
      const dlog = new PluginDiagnosticLogger(logDir, apiLogger);
      await seedEntries(dlog);
      const { entries, total } = await dlog.readLogs({ limit: 2 });
      expect(entries).toHaveLength(2);
      expect(total).toBe(5);
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
    dlog.warn("plugin.rpc", "ping.error", "test warning");
    await dlog.flush();
  });

  it("returns entries and total matching RPC response shape", async () => {
    const result = await dlog.readLogs({ level: "warn", limit: 10 });
    expect(result).toHaveProperty("entries");
    expect(result).toHaveProperty("total");
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].level).toBe("warn");
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
