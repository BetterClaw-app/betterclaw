// src/routing/audit-log.ts
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AuditEntry } from "./types.js";

const AUDIT_FILE = "routing-audit.jsonl";

export class AuditLog {
  private filePath: string;

  constructor(stateDir: string) {
    this.filePath = path.join(stateDir, AUDIT_FILE);
  }

  async appendEdit(entry: AuditEntry): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const line = JSON.stringify(entry) + "\n";
    await fs.appendFile(this.filePath, line, "utf8");
  }

  async readSince(cutoffTs: number): Promise<AuditEntry[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const out: AuditEntry[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as AuditEntry;
        if (entry.ts > cutoffTs) out.push(entry);
      } catch {
        // skip malformed
      }
    }
    return out;
  }
}

/** Pure: compute the set of JSON-Pointer paths locked by unexpired user edits. */
export function computeLockedKeys(
  entries: AuditEntry[],
  now: number,
  _windowSec: number, // kept for signature symmetry; per-entry expiresAt is authoritative
): Set<string> {
  const locked = new Set<string>();
  for (const e of entries) {
    if (e.source !== "user") continue;
    if (e.expiresAt === undefined) continue;
    if (e.expiresAt <= now) continue;
    for (const d of e.diffs) {
      locked.add(d.path);
    }
  }
  return locked;
}
