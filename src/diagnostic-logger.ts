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

  // Rotation mutex: readers (`readLogs`) hold shared; rotate() holds exclusive.
  // Satisfies spec I7 per-call atomicity.
  //
  // Implementation note: `_acquireRead` re-checks `_rotationInFlight` in a
  // loop after each await. Without the loop, a freshly-woken reader could
  // bump `_readersActive` concurrently with a newly-arriving rotation that
  // set `_rotationInFlight = true` but hasn't yet observed readers — that's
  // the check-then-increment race. The loop + single-threaded event-loop
  // semantics close it: when the loop condition is re-evaluated the reader
  // either sees the new rotation (and waits) or is safely past it.
  private _readersActive = 0;
  private _rotationWaiters: Array<() => void> = [];
  private _rotationInFlight = false;
  private _rotationReleasers: Array<() => void> = [];

  private async _acquireRead(): Promise<() => void> {
    // Loop because a new rotation may start between wake-up and increment.
    while (this._rotationInFlight) {
      await new Promise<void>((resolve) => this._rotationWaiters.push(resolve));
    }
    this._readersActive++;
    return () => {
      this._readersActive--;
      if (this._readersActive === 0) {
        const releasers = this._rotationReleasers.splice(0);
        releasers.forEach((r) => r());
      }
    };
  }

  private async _acquireRotation(): Promise<() => void> {
    // Set the flag FIRST so any reader arriving during this acquire sees the
    // rotation and waits. Readers already past the while-loop (readersActive
    // > 0) must drain before we proceed; we park on _rotationReleasers.
    this._rotationInFlight = true;
    if (this._readersActive > 0) {
      await new Promise<void>((resolve) =>
        this._rotationReleasers.push(resolve),
      );
    }
    return () => {
      this._rotationInFlight = false;
      const waiters = this._rotationWaiters.splice(0);
      waiters.forEach((w) => w());
    };
  }

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

  private static warnDeprecationEmitted = false;

  /** @internal test helper — resets the one-shot deprecation flag. */
  static _resetWarnDeprecationForTest(): void {
    PluginDiagnosticLogger.warnDeprecationEmitted = false;
  }

  scoped(source: string): PluginModuleLogger {
    return {
      info: (msg: string) => this.info(source, "info", msg),
      warn: (msg: string) => this.warning(source, "warn", msg),
      error: (msg: string) => this.error(source, "error", msg),
    };
  }

  async readLogs(opts: { since?: number; until?: number; limit?: number; level?: string; source?: string; skipUntil?: { ts: number; idx: number } } = {}): Promise<{ entries: PluginLogEntry[]; total: number; _cursorState: { ts: number; idx: number } | null }> {
    const release = await this._acquireRead();
    try {
      return await this._readLogsInner(opts);
    } finally {
      release();
    }
  }

  private async _readLogsInner(opts: { since?: number; until?: number; limit?: number; level?: string; source?: string; skipUntil?: { ts: number; idx: number } } = {}): Promise<{ entries: PluginLogEntry[]; total: number; _cursorState: { ts: number; idx: number } | null }> {
    // Intentional adaptation from plan: `since` default is 0 (not now - 86400)
    // so pagination across a full export reads everything within the window.
    const since = opts.since ?? 0;
    const until = opts.until ?? Number.MAX_SAFE_INTEGER;
    const limit = Math.min(opts.limit ?? 200, 50_000);
    const minLevelIdx = opts.level ? LEVEL_ORDER.indexOf(opts.level as (typeof LEVEL_ORDER)[number]) : 0;
    const skip = opts.skipUntil;

    let files: string[];
    try {
      files = (await fs.readdir(this.logDir))
        .filter(f => f.startsWith("diagnostic-") && f.endsWith(".jsonl"))
        .sort();
    } catch {
      return { entries: [], total: 0, _cursorState: null };
    }

    const allEntries: PluginLogEntry[] = [];

    for (const file of files) {
      // Optional: skip files entirely out of window. Day boundaries:
      // startOfDay <= ts < startOfDay + 86400.
      const dateMatch = file.match(/diagnostic-(\d{4}-\d{2}-\d{2})\.jsonl/);
      if (dateMatch) {
        const startOfDay = new Date(dateMatch[1] + "T00:00:00").getTime() / 1000;
        const endOfDay = startOfDay + 86400;
        if (endOfDay <= since || startOfDay > until) continue;
      }

      let content: string;
      try {
        content = await fs.readFile(path.join(this.logDir, file), "utf-8");
      } catch {
        continue;
      }

      // I3 (CURSOR_CLAMP): `since`/`until` are applied to every entry BEFORE
      // the skip gate below. A forged cursor cannot widen the window because
      // entries outside [since, until] never enter `allEntries`.
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as PluginLogEntry;
          if (entry.timestamp < since) continue;
          if (entry.timestamp > until) continue;
          if (minLevelIdx > 0 && LEVEL_ORDER.indexOf(entry.level) < minLevelIdx) continue;
          if (opts.source && !entry.source.startsWith(opts.source)) continue;
          allEntries.push(entry);
        } catch {
          // Skip malformed lines
        }
      }
    }

    // I2 (CURSOR_ASC): sort ASC so the page cursor represents a monotonically
    // non-decreasing (ts, idx). Stable sort preserves insertion order within
    // identical timestamps, matching the per-file append order on disk.
    allEntries.sort((a, b) => a.timestamp - b.timestamp);

    // Apply skip gate: skip all entries with ts < skip.ts; within ts === skip.ts
    // run, skip the first skip.idx entries (0-based intra-ts counter).
    let sliceStart = 0;
    if (skip) {
      while (sliceStart < allEntries.length && allEntries[sliceStart].timestamp < skip.ts) {
        sliceStart++;
      }
      let intraTsCount = 0;
      while (
        sliceStart < allEntries.length &&
        allEntries[sliceStart].timestamp === skip.ts &&
        intraTsCount < skip.idx
      ) {
        sliceStart++;
        intraTsCount++;
      }
    }

    const pageEntries = allEntries.slice(sliceStart, sliceStart + limit);
    const total = allEntries.length;

    // Next cursor: only if a full page was returned AND there is more beyond.
    // `idx` counts how many entries at the last ts appear in THIS page (including
    // any that were also counted by a prior page's cursor skip). The caller
    // re-seeds skipUntil with {ts: lastTs, idx: cumulativeRunCount}.
    let _cursorState: { ts: number; idx: number } | null = null;
    if (pageEntries.length === limit && sliceStart + limit < allEntries.length) {
      const lastTs = pageEntries[pageEntries.length - 1].timestamp;
      let idx = 0;
      for (let i = pageEntries.length - 1; i >= 0; i--) {
        if (pageEntries[i].timestamp === lastTs) idx++;
        else break;
      }
      // If skip was also at this ts, the caller needs the cumulative count.
      if (skip && skip.ts === lastTs) idx += skip.idx;
      _cursorState = { ts: lastTs, idx };
    }

    return { entries: pageEntries, total, _cursorState };
  }

  async rotate(): Promise<void> {
    const release = await this._acquireRotation();
    try {
      await this._rotateInner();
    } finally {
      release();
    }
  }

  private async _rotateInner(): Promise<void> {
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
  PluginDiagnosticLogger._resetWarnDeprecationForTest();
}
