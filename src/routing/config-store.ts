// src/routing/config-store.ts
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { RoutingRules, AuditEntry, KeyDiff } from "./types.js";
import type { AuditLog } from "./audit-log.js";
import { shippedDefaults } from "./shipped-defaults.js";

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
        return new RoutingConfigStore(stateDir, audit, rules, checksum);
      }
      // Corrupt JSON or other read error — in-memory defaults, preserve file
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

    return new RoutingConfigStore(stateDir, audit, rules, currentChecksum);
  }

  getRules(): RoutingRules { return this.rules; }
  getChecksum(): string { return this.checksum; }
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
