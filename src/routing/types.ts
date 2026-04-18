// src/routing/types.ts

/** Triage/rule action. Ternary — there is no "silent". */
export type RoutingAction = "drop" | "push" | "notify";

/** Match clause inside a rule. Either a wildcard or a fielded match. */
export type RuleMatch = "*" | RuleMatchFields;

export interface RuleMatchFields {
  source?: string;
  /** "enter" / "exit" → translates to event.data.type === 1/0 */
  type?: "enter" | "exit";
  /** Matches event.metadata?.zoneName (exact). */
  geofenceLabel?: string;
  /** Numeric comparison, e.g. "< 0.2", ">= 0.5". Matches event.data.level. */
  level?: string;
}

/** One rule in routing-rules.json. */
export interface Rule {
  id: string;
  match: RuleMatch;
  action: RoutingAction;
  /** If true, a match short-circuits the LLM triage. */
  explicit: boolean;
  /** If true, quiet-hours can demote notify → push. Default true. */
  respectQuietHours?: boolean;
  /** Per-rule cooldown minutes. Falls back to plugin default. */
  cooldownMin?: number;
}

export interface QuietHoursConfig {
  /** "HH:MM" 24-hour. */
  start: string;
  /** "HH:MM" 24-hour. */
  end: string;
  /** IANA tz name, or "auto" to use last-reported device tz. */
  tz: string;
}

export interface RoutingRules {
  version: 1;
  quietHours: QuietHoursConfig;
  rules: Rule[];
}

/** Return type of RuleMatcher.matchEvent. */
export interface RuleMatchResult {
  rule: Rule;
  index: number;
  action: RoutingAction;
}

/** One entry in routing-audit.jsonl. */
export interface AuditEntry {
  /** Unix seconds. */
  ts: number;
  source: "user" | "agent" | "learner" | "default";
  /** Required for agent/learner entries. */
  reason?: string;
  /** sha256 of the full config after this edit. */
  docChecksum: string;
  diffs: KeyDiff[];
  /** Only set for source: "user". = ts + 14*86400. */
  expiresAt?: number;
}

export interface KeyDiff {
  /** JSON-Pointer-like path. e.g. "/rules/0/action". */
  path: string;
  from: unknown;
  to: unknown;
}

/** RFC 6902 JSON Patch op (restricted subset we accept). */
export interface JsonPatchOp {
  op: "replace" | "add" | "remove";
  path: string;
  value?: unknown;
}
