import * as fs from "node:fs/promises";
import * as path from "node:path";
import { noopLogger, type PluginModuleLogger, type ReactionEntry, type ReactionStatus } from "./types.js";

export class ReactionTracker {
  private reactions: ReactionEntry[] = [];
  private filePath: string;
  private logger: PluginModuleLogger;

  constructor(stateDir: string, logger?: PluginModuleLogger) {
    this.filePath = path.join(stateDir, "push-reactions.jsonl");
    this.logger = logger ?? noopLogger;
  }

  recordPush(entry: { subscriptionId: string; source: string; pushedAt: number; messageSummary: string }): void {
    this.reactions.push({
      ...entry,
      status: "pending",
    });
  }

  /** Classify a reaction by matching on subscriptionId + pushedAt compound key */
  classify(subscriptionId: string, pushedAt: number, status: ReactionStatus, reason: string): void {
    const entry = this.reactions.find(
      (r) => r.subscriptionId === subscriptionId && r.pushedAt === pushedAt && r.status === "pending"
    );
    if (entry) {
      entry.status = status;
      entry.classifiedAt = Date.now() / 1000;
      entry.classificationReason = reason;
    }
  }

  /** Get pending (unclassified) reactions; optionally filtered to the last N hours */
  getPending(hours?: number): ReactionEntry[] {
    const pending = this.reactions.filter((r) => r.status === "pending");
    if (hours === undefined) {
      return pending;
    }
    const cutoff = Date.now() / 1000 - hours * 3600;
    return pending.filter((r) => r.pushedAt >= cutoff);
  }

  getRecent(_hours?: number): ReactionEntry[] {
    return [...this.reactions];
  }

  /** Get classified reactions for learner input */
  getClassified(hours: number = 24): ReactionEntry[] {
    const cutoff = Date.now() / 1000 - hours * 3600;
    return this.reactions.filter((r) => r.status !== "pending" && r.pushedAt >= cutoff);
  }

  async save(): Promise<boolean> {
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const lines = this.reactions.map((r) => JSON.stringify(r)).join("\n");
      await fs.writeFile(this.filePath, lines + "\n", "utf-8");
      return true;
    } catch (err) {
      this.logger.error(`reactions save failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  async load(): Promise<void> {
    try {
      const content = await fs.readFile(this.filePath, "utf-8");
      this.reactions = content
        .trim()
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => {
          try { return [JSON.parse(line) as ReactionEntry]; }
          catch { return []; }
        });
    } catch {
      this.reactions = [];
    }
  }

  rotate(): void {
    const cutoff = Date.now() / 1000 - 30 * 86400;
    this.reactions = this.reactions.filter((r) => r.pushedAt >= cutoff);
  }
}
