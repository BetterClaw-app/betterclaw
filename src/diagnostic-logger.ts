import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PluginModuleLogger, PluginLogEntry } from "./types.js";

const LEVEL_ORDER = ["debug", "info", "notice", "warning", "error", "critical"] as const;

/** Lean interface for module-facing logging. Modules import `dlog` and call these methods. */
export interface DiagnosticLogWriter {
  debug(source: string, event: string, message: string, data?: Record<string, unknown>): void;
  info(source: string, event: string, message: string, data?: Record<string, unknown>): void;
  notice(source: string, event: string, message: string, data?: Record<string, unknown>): void;
  warning(source: string, event: string, message: string, data?: Record<string, unknown>): void;
  /** @deprecated Use `warning` instead. Routes to `warning`; emits a one-shot console.warn. */
  warn(source: string, event: string, message: string, data?: Record<string, unknown>): void;
  error(source: string, event: string, message: string, data?: Record<string, unknown>): void;
  critical(source: string, event: string, message: string, data?: Record<string, unknown>): void;
}

const NOOP: DiagnosticLogWriter = {
  debug() {}, info() {}, notice() {}, warning() {}, warn() {}, error() {}, critical() {},
};

/**
 * Singleton diagnostic logger. Always a valid object:
 * - Before initDiagnosticLogger(): silent no-op (safe in tests)
 * - After initDiagnosticLogger(): real logger with JSONL persistence + dual-write
 *
 * Modules import this for structured logging. index.ts uses the full
 * PluginDiagnosticLogger instance (returned by init) for readLogs/rotate/flush/scoped.
 */
export let dlog: DiagnosticLogWriter = NOOP;

/** Initialize the singleton. Call once from index.ts register(). Returns the full instance. */
export function initDiagnosticLogger(logDir: string, apiLogger: PluginModuleLogger): PluginDiagnosticLogger {
  const instance = new PluginDiagnosticLogger(logDir, apiLogger);
  dlog = instance;
  return instance;
}

export class PluginDiagnosticLogger implements DiagnosticLogWriter {
  private logDir: string;
  private apiLogger: PluginModuleLogger;
  private circuitBroken = false;
  private dirEnsured = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(logDir: string, apiLogger: PluginModuleLogger) {
    this.logDir = logDir;
    this.apiLogger = apiLogger;
  }

  debug(source: string, event: string, message: string, data?: Record<string, unknown>): void {
    this.writeEntry({ timestamp: Date.now() / 1000, level: "debug", source, event, message, ...(data !== undefined && { data }) });
  }

  info(source: string, event: string, message: string, data?: Record<string, unknown>): void {
    this.writeEntry({ timestamp: Date.now() / 1000, level: "info", source, event, message, ...(data !== undefined && { data }) });
    this.apiLogger.info(`[${source}] ${message}`);
  }

  notice(source: string, event: string, message: string, data?: Record<string, unknown>): void {
    this.writeEntry({ timestamp: Date.now() / 1000, level: "notice", source, event, message, ...(data !== undefined && { data }) });
    this.apiLogger.info(`[${source}] ${message}`);
  }

  warning(source: string, event: string, message: string, data?: Record<string, unknown>): void {
    this.writeEntry({ timestamp: Date.now() / 1000, level: "warning", source, event, message, ...(data !== undefined && { data }) });
    this.apiLogger.warn(`[${source}] ${message}`);
  }

  /** @deprecated Routes to `warning`. Emits one-shot console.warn on first use. */
  warn(source: string, event: string, message: string, data?: Record<string, unknown>): void {
    if (!PluginDiagnosticLogger.warnDeprecationEmitted) {
      PluginDiagnosticLogger.warnDeprecationEmitted = true;
      console.warn("[diagnostic-logger] .warn() is deprecated, use .warning() instead"); // schema-lint: allow-console
    }
    this.warning(source, event, message, data);
  }

  error(source: string, event: string, message: string, data?: Record<string, unknown>): void {
    this.writeEntry({ timestamp: Date.now() / 1000, level: "error", source, event, message, ...(data !== undefined && { data }) });
    this.apiLogger.error(`[${source}] ${message}`);
  }

  critical(source: string, event: string, message: string, data?: Record<string, unknown>): void {
    this.writeEntry({ timestamp: Date.now() / 1000, level: "critical", source, event, message, ...(data !== undefined && { data }) });
    this.apiLogger.error(`[${source}] ${message}`);
  }

  static warnDeprecationEmitted = false;

  scoped(source: string): PluginModuleLogger {
    return {
      info: (msg: string) => this.info(source, "info", msg),
      warn: (msg: string) => this.warning(source, "warn", msg),
      error: (msg: string) => this.error(source, "error", msg),
    };
  }

  async readLogs(opts: { since?: number; limit?: number; level?: string; source?: string } = {}): Promise<{ entries: PluginLogEntry[]; total: number }> {
    const since = opts.since ?? (Date.now() / 1000 - 86400);
    const limit = Math.min(opts.limit ?? 200, 50_000);
    const minLevelIdx = opts.level ? LEVEL_ORDER.indexOf(opts.level as (typeof LEVEL_ORDER)[number]) : 0;

    let files: string[];
    try {
      files = (await fs.readdir(this.logDir))
        .filter(f => f.startsWith("diagnostic-") && f.endsWith(".jsonl"))
        .sort()
        .reverse();
    } catch {
      return { entries: [], total: 0 };
    }

    const allEntries: PluginLogEntry[] = [];

    for (const file of files) {
      const dateMatch = file.match(/diagnostic-(\d{4}-\d{2}-\d{2})\.jsonl/);
      if (dateMatch) {
        const endOfDay = new Date(dateMatch[1] + "T23:59:59").getTime() / 1000;
        if (endOfDay < since) break;
      }

      let content: string;
      try {
        content = await fs.readFile(path.join(this.logDir, file), "utf-8");
      } catch {
        continue;
      }

      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as PluginLogEntry;
          if (entry.timestamp < since) continue;
          if (minLevelIdx > 0 && LEVEL_ORDER.indexOf(entry.level) < minLevelIdx) continue;
          if (opts.source && !entry.source.startsWith(opts.source)) continue;
          allEntries.push(entry);
        } catch {
          // Skip malformed lines
        }
      }
    }

    allEntries.sort((a, b) => a.timestamp - b.timestamp);
    const total = allEntries.length;
    const entries = total > limit ? allEntries.slice(total - limit) : allEntries;
    return { entries, total };
  }

  async rotate(): Promise<void> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);
    const cutoffStr = this.formatDate(cutoff);

    let files: string[];
    try {
      files = await fs.readdir(this.logDir);
    } catch {
      return;
    }

    for (const file of files) {
      const dateMatch = file.match(/diagnostic-(\d{4}-\d{2}-\d{2})\.jsonl/);
      if (dateMatch && dateMatch[1] < cutoffStr) {
        try {
          await fs.unlink(path.join(this.logDir, file));
        } catch { /* already deleted */ }
      }
    }

    this.circuitBroken = false;
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }

  private writeEntry(entry: PluginLogEntry): void {
    if (this.circuitBroken) return;

    const filePath = path.join(this.logDir, `diagnostic-${this.formatDate(new Date())}.jsonl`);
    const line = JSON.stringify(entry) + "\n";

    this.writeChain = this.writeChain
      .then(async () => {
        if (!this.dirEnsured) {
          await fs.mkdir(this.logDir, { recursive: true });
          this.dirEnsured = true;
        }
        await fs.appendFile(filePath, line, "utf-8");
      })
      .catch(() => {
        if (!this.circuitBroken) {
          this.apiLogger.warn("[diagnostic-logger] disk write failed, circuit breaker tripped");
        }
        this.circuitBroken = true;
      });
  }

  private formatDate(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
}

/** @internal test helper — resets the one-shot deprecation flag. */
export function _resetWarnDeprecationForTest(): void {
  PluginDiagnosticLogger.warnDeprecationEmitted = false;
}
