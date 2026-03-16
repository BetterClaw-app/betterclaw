import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ReactionEntry } from "./types.js";

export class ReactionTracker {
  private reactions: ReactionEntry[] = [];
  private filePath: string;

  constructor(stateDir: string) {
    this.filePath = path.join(stateDir, "push-reactions.jsonl");
  }

  recordPush(entry: Omit<ReactionEntry, "engaged" | "checkedAt">): void {
    this.reactions.push({ ...entry, engaged: null });
  }

  markEngaged(idempotencyKey: string, engaged: boolean): void {
    const entry = this.reactions.find((r) => r.idempotencyKey === idempotencyKey);
    if (entry) {
      entry.engaged = engaged;
      entry.checkedAt = Date.now() / 1000;
    }
  }

  getRecent(hours: number): ReactionEntry[] {
    const cutoff = Date.now() / 1000 - hours * 3600;
    return this.reactions.filter((r) => r.pushedAt >= cutoff);
  }

  async save(): Promise<void> {
    const lines = this.reactions.map((r) => JSON.stringify(r)).join("\n");
    await fs.writeFile(this.filePath, lines + "\n", "utf-8");
  }

  async load(): Promise<void> {
    try {
      const content = await fs.readFile(this.filePath, "utf-8");
      this.reactions = content
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as ReactionEntry);
    } catch {
      this.reactions = [];
    }
  }

  /** Rotate: keep only last 30 days */
  rotate(): void {
    const cutoff = Date.now() / 1000 - 30 * 86400;
    this.reactions = this.reactions.filter((r) => r.pushedAt >= cutoff);
  }
}
