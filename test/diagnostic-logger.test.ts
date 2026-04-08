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
});
