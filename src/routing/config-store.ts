// src/routing/config-store.ts
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { RoutingRules, AuditEntry, KeyDiff, JsonPatchOp } from "./types.js";
import type { AuditLog } from "./audit-log.js";
import { computeLockedKeys } from "./audit-log.js";
import { shippedDefaults } from "./shipped-defaults.js";
import { applyPatch as applyPatchPure } from "./patch-applier.js";
import { dlog } from "../diagnostic-logger.js";

const RULES_FILE = "routing-rules.json";
const LASTKNOWN_FILE = "routing-rules.lastknown.json";
const USER_LOCK_WINDOW_SEC = 14 * 86400;

export class RoutingConfigStore {
  private constructor(
    private stateDir: string,
    private audit: AuditLog,
    private rules: RoutingRules,
    private checksum: string,
  ) {}

  static async load(stateDir: string, audit: AuditLog): Promise<RoutingConfigStore> {
    const rulesPath = path.join(stateDir, RULES_FILE);
    const lastknownPath = path.join(stateDir, LASTKNOWN_FILE);

    let rules: RoutingRules;
    let rawCurrent: string | null = null;

    try {
      rawCurrent = await fs.readFile(rulesPath, "utf8");
      rules = JSON.parse(rawCurrent) as RoutingRules;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // First run — write defaults
        rules = shippedDefaults();
        rawCurrent = JSON.stringify(rules, null, 2);
        await fs.mkdir(stateDir, { recursive: true });
        await fs.writeFile(rulesPath, rawCurrent);
        await fs.writeFile(lastknownPath, rawCurrent);
        const checksum = sha256(rawCurrent);
        await audit.appendEdit({
          ts: nowSec(),
          source: "default",
          reason: "initial bootstrap",
          docChecksum: checksum,
          diffs: [{ path: "", from: null, to: rules }],
        });
        dlog.info("plugin.routing", "config.bootstrapped", "shipped defaults written on first run", { rules: rules.rules.length });
        return new RoutingConfigStore(stateDir, audit, rules, checksum);
      }
      // Corrupt JSON or other read error — in-memory defaults, preserve file
      dlog.error("plugin.routing", "config.load.error", "routing-rules.json unreadable; using in-memory defaults",
        { err: (err as Error).message });
      rules = shippedDefaults();
      return new RoutingConfigStore(stateDir, audit, rules, sha256(JSON.stringify(rules)));
    }

    const currentChecksum = sha256(rawCurrent);

    // Compare to lastknown
    let lastknownRaw: string | null = null;
    try { lastknownRaw = await fs.readFile(lastknownPath, "utf8"); } catch { /* missing */ }

    if (lastknownRaw !== null && sha256(lastknownRaw) === currentChecksum) {
      return new RoutingConfigStore(stateDir, audit, rules, currentChecksum);
    }

    // Manual edit detected (or lastknown missing / out of sync)
    const previousRules: RoutingRules | null = lastknownRaw
      ? safeParse<RoutingRules>(lastknownRaw)
      : null;
    const diffs: KeyDiff[] = previousRules
      ? computeDiffs(previousRules as unknown as Record<string, unknown>, rules as unknown as Record<string, unknown>, "")
      : [{ path: "", from: null, to: rules }];

    const now = nowSec();
    await audit.appendEdit({
      ts: now,
      source: "user",
      docChecksum: currentChecksum,
      diffs,
      expiresAt: now + USER_LOCK_WINDOW_SEC,
    });
    await fs.writeFile(lastknownPath, rawCurrent);
    dlog.info("plugin.routing", "config.manual.edit.detected", "manual edit detected on load",
      { diffCount: diffs.length, expiresAt: now + USER_LOCK_WINDOW_SEC });

    return new RoutingConfigStore(stateDir, audit, rules, currentChecksum);
  }

  getRules(): RoutingRules { return this.rules; }
  getChecksum(): string { return this.checksum; }

  private writeQueue: Promise<void> = Promise.resolve();

  async applyPatch(
    patch: JsonPatchOp[],
    source: "agent" | "learner" | "default",
    reason: string,
  ): Promise<{ applied: JsonPatchOp[]; dropped: Array<{ op: JsonPatchOp; reason: string }> }> {
    // Serialize writes through a promise chain. Each call awaits the previous
    // turn before doing its I/O, and parks the next call behind its own turn.
    const prior = this.writeQueue;
    let release!: () => void;
    this.writeQueue = new Promise<void>(r => { release = r; });
    await prior;

    try {
      // Check for manual user edit that happened since last load
      await this.detectAndRecordManualEdit();

      // Compute lockedKeys from the audit log
      const now = nowSec();
      const auditEntries = await this.audit.readSince(now - USER_LOCK_WINDOW_SEC);
      const lockedKeys = computeLockedKeys(auditEntries, now, USER_LOCK_WINDOW_SEC);

      // Apply patch
      const { result, applied, dropped } = applyPatchPure(this.rules, patch, lockedKeys);

      if (applied.length > 0) {
        const newRaw = JSON.stringify(result, null, 2);
        const newChecksum = sha256(newRaw);
        const rulesPath = path.join(this.stateDir, RULES_FILE);
        const lastknownPath = path.join(this.stateDir, LASTKNOWN_FILE);

        // Compute diffs between previous and new
        const diffs = computeDiffs(this.rules as unknown, result as unknown, "");

        // Atomic write via tmp+rename
        const tmpRules = rulesPath + ".tmp";
        await fs.writeFile(tmpRules, newRaw);
        await fs.rename(tmpRules, rulesPath);
        await fs.writeFile(lastknownPath, newRaw);

        await this.audit.appendEdit({
          ts: now,
          source,
          reason,
          docChecksum: newChecksum,
          diffs,
        });

        this.rules = result;
        this.checksum = newChecksum;
      }

      return { applied, dropped };
    } finally {
      release();
    }
  }

  private async detectAndRecordManualEdit(): Promise<void> {
    const rulesPath = path.join(this.stateDir, RULES_FILE);
    let raw: string;
    try { raw = await fs.readFile(rulesPath, "utf8"); } catch { return; }
    const onDiskChecksum = sha256(raw);
    if (onDiskChecksum === this.checksum) return;

    const onDisk = safeParse<RoutingRules>(raw);
    if (!onDisk) return; // corrupt on-disk — leave alone, in-memory stays authoritative

    const diffs = computeDiffs(this.rules as unknown, onDisk as unknown, "");
    const now = nowSec();
    await this.audit.appendEdit({
      ts: now,
      source: "user",
      docChecksum: onDiskChecksum,
      diffs,
      expiresAt: now + USER_LOCK_WINDOW_SEC,
    });

    this.rules = onDisk;
    this.checksum = onDiskChecksum;
    const lastknownPath = path.join(this.stateDir, LASTKNOWN_FILE);
    await fs.writeFile(lastknownPath, raw);
    dlog.info("plugin.routing", "config.manual.edit.detected", "manual edit detected mid-patch",
      { diffCount: diffs.length, expiresAt: now + USER_LOCK_WINDOW_SEC });
  }
}

function nowSec(): number { return Math.floor(Date.now() / 1000); }

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function safeParse<T>(s: string): T | null {
  try { return JSON.parse(s) as T; } catch { return null; }
}

function computeDiffs(
  from: unknown,
  to: unknown,
  pathPrefix: string,
): KeyDiff[] {
  if (typeof from !== typeof to || typeof from !== "object" || from === null || to === null) {
    if (!deepEqual(from, to)) return [{ path: pathPrefix, from, to }];
    return [];
  }
  if (Array.isArray(from) && Array.isArray(to)) {
    // Recurse into arrays by index so lock paths are granular (e.g. /rules/0/action).
    // If lengths differ, the extra slot is emitted as undefined→value or value→undefined.
    const len = Math.max(from.length, to.length);
    const out: KeyDiff[] = [];
    for (let i = 0; i < len; i++) {
      out.push(...computeDiffs(from[i], to[i], `${pathPrefix}/${i}`));
    }
    return out;
  }
  if (Array.isArray(from) || Array.isArray(to)) {
    // Structural type mismatch (one is array, the other isn't)
    if (!deepEqual(from, to)) return [{ path: pathPrefix, from, to }];
    return [];
  }
  const a = from as Record<string, unknown>;
  const b = to as Record<string, unknown>;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: KeyDiff[] = [];
  for (const k of keys) {
    const sub = pathPrefix + "/" + k.replace(/~/g, "~0").replace(/\//g, "~1");
    out.push(...computeDiffs(a[k], b[k], sub));
  }
  return out;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
