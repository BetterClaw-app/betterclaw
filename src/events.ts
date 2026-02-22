import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { EventLogEntry } from "./types.js";

const EVENTS_FILE = "events.jsonl";
const MAX_LINES = 10_000;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export class EventLog {
  private filePath: string;

  constructor(stateDir: string) {
    this.filePath = path.join(stateDir, EVENTS_FILE);
  }

  async append(entry: EventLogEntry): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const line = JSON.stringify(entry) + "\n";
    await fs.appendFile(this.filePath, line, "utf8");
  }

  async readAll(): Promise<EventLogEntry[]> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      return raw
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as EventLogEntry);
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
    const entries = await this.readAll();
    if (entries.length <= MAX_LINES) return 0;

    const cutoff = Date.now() / 1000 - MAX_AGE_MS / 1000;
    const kept = entries.filter((e) => e.timestamp >= cutoff).slice(-MAX_LINES);
    const removed = entries.length - kept.length;

    const content = kept.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await fs.writeFile(this.filePath, content, "utf8");

    return removed;
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
