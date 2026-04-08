import * as fs from "node:fs/promises";
import * as path from "node:path";
import { noopLogger, type EventLogEntry, type PluginModuleLogger } from "./types.js";

const EVENTS_FILE = "events.jsonl";
const MAX_LINES = 10_000;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export class EventLog {
  private filePath: string;
  private logger: PluginModuleLogger;

  constructor(stateDir: string, logger?: PluginModuleLogger) {
    this.filePath = path.join(stateDir, EVENTS_FILE);
    this.logger = logger ?? noopLogger;
  }

  async append(entry: EventLogEntry): Promise<boolean> {
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const line = JSON.stringify(entry) + "\n";
      await fs.appendFile(this.filePath, line, "utf8");
      return true;
    } catch (err) {
      this.logger.error(`events append failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  async readAll(): Promise<EventLogEntry[]> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      return raw
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .flatMap((line) => {
          try { return [JSON.parse(line) as EventLogEntry]; }
          catch { return []; }
        });
    } catch {
      return [];
    }
  }

  async readRecent(limit: number = 20): Promise<EventLogEntry[]> {
    const all = await this.readAll();
    return all.slice(-limit);
  }

  async readSince(sinceEpoch: number): Promise<EventLogEntry[]> {
    const all = await this.readAll();
    return all.filter((e) => e.timestamp >= sinceEpoch);
  }

  async rotate(): Promise<number> {
    try {
      const entries = await this.readAll();
      if (entries.length <= MAX_LINES) return 0;

      const cutoff = Date.now() / 1000 - MAX_AGE_MS / 1000;
      const kept = entries.filter((e) => e.timestamp >= cutoff).slice(-MAX_LINES);
      const removed = entries.length - kept.length;

      const content = kept.map((e) => JSON.stringify(e)).join("\n") + "\n";
      const tmpPath = this.filePath + ".tmp";
      await fs.writeFile(tmpPath, content, "utf8");
      await fs.rename(tmpPath, this.filePath);

      return removed;
    } catch (err) {
      this.logger.error(`events rotate failed: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }

  async count(): Promise<number> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      return raw.trim().split("\n").filter((l) => l.length > 0).length;
    } catch {
      return 0;
    }
  }
}
