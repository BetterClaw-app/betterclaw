import { createHmac } from "node:crypto";
import type { PluginLogEntry } from "./types.js";

// ---------------------------------------------------------------------------
// Strategies
// ---------------------------------------------------------------------------

const MAX_VALUE_BYTES = 8192;

export function hmacHost(value: string, key: Buffer): string {
  return "hmac:" + createHmac("sha256", key).update(value).digest("hex").slice(0, 16);
}

export function hmacUrlHost(value: string, key: Buffer): string {
  try {
    const u = new URL(value);
    return hmacHost(u.host, key);
  } catch {
    return "hmac:invalid";
  }
}

export function hmacId(value: string, key: Buffer): string {
  return "hmac:" + createHmac("sha256", key).update(value).digest("hex").slice(0, 12);
}

export function allowPlain(value: unknown): unknown {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (v === null) return null;
    const t = typeof v;
    if (t === "string") {
      const s = v as string;
      return s.length > MAX_VALUE_BYTES
        ? s.slice(0, MAX_VALUE_BYTES) + `…[truncated ${s.length - MAX_VALUE_BYTES} bytes]`
        : s;
    }
    if (t === "number" || t === "boolean") return v;
    if (t === "bigint") return String(v);
    if (v instanceof Date || v instanceof URL) return String(v);
    if (Array.isArray(v)) {
      if (seen.has(v)) return "[circular]";
      seen.add(v);
      return v.map(walk);
    }
    if (t === "object") {
      if (seen.has(v as object)) return "[circular]";
      seen.add(v as object);
      const out: Record<string, unknown> = {};
      for (const [k, vv] of Object.entries(v as object)) out[k] = walk(vv);
      return out;
    }
    return String(v);  // undefined, functions, symbols
  };
  return walk(value);
}

export function drop(): undefined {
  return undefined;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExportCategory =
  | "connection" | "heartbeat" | "commands" | "dns"
  | "lifecycle"
  | "subscriptions" | "health" | "location" | "geofence";

export type ExportSettings = Record<ExportCategory, boolean>;

type Strategy = "hmacHost" | "hmacUrlHost" | "hmacId" | "allowPlain" | "drop";

type SourceDef = {
  exportCategory: ExportCategory;
  fieldLevelMapping?: boolean;
  events: Record<string, { level: "debug" | "info" | "notice" | "warning" | "error" | "critical"; requiredKeys: string[] }>;
};

// ---------------------------------------------------------------------------
// MANIFEST — single source of truth
// ---------------------------------------------------------------------------

export const MANIFEST: {
  manifestVersion: number;
  sources: Record<string, SourceDef>;
  keyStrategies: Record<string, Strategy>;
  fieldCategoryImplications: Record<string, ExportCategory>;
} = {
  manifestVersion: 1,

  sources: {
    "plugin.service": {
      exportCategory: "lifecycle",
      events: {
        "loaded":        { level: "info",  requiredKeys: [] },
        "init.phase":    { level: "info",  requiredKeys: ["phase", "success"] },
        "init.complete": { level: "info",  requiredKeys: ["durationMs"] },
        "started":       { level: "info",  requiredKeys: [] },
        "stopped":       { level: "info",  requiredKeys: [] },
        "info": { level: "info",  requiredKeys: [] },  // scoped
        "warn": { level: "warning", requiredKeys: [] },  // scoped
        "error": { level: "error", requiredKeys: [] },  // scoped
      },
    },
    "plugin.rpc": {
      exportCategory: "lifecycle",
      events: {
        "ping.received":     { level: "info",    requiredKeys: [] },
        "node.hygiene":      { level: "info",    requiredKeys: [] },
        "config.applied":    { level: "info",    requiredKeys: ["changedFields"] },
        "config.error":      { level: "error",   requiredKeys: [] },
        "context.served":    { level: "info",    requiredKeys: ["tier"] },
        "context.error":     { level: "error",   requiredKeys: [] },
        "learn.triggered":   { level: "info",    requiredKeys: [] },
        "learn.error":       { level: "error",   requiredKeys: [] },
        "snapshot.applied":  { level: "info",    requiredKeys: ["fieldCount"] },
        "snapshot.error":    { level: "error",   requiredKeys: [] },
        "event.error":       { level: "error",   requiredKeys: [] },
        "logs.error":        { level: "error",   requiredKeys: [] },
        "shortcut.delivered": { level: "info",  requiredKeys: ["commandId", "ok", "status"] },
        "shortcut.failed":    { level: "error", requiredKeys: ["commandId"] },
        "shortcut.error":     { level: "error", requiredKeys: [] },
      },
    },
    "plugin.pipeline": {
      exportCategory: "lifecycle",
      events: {
        "event.error":       { level: "error", requiredKeys: [] },
        "event.received":    { level: "info",  requiredKeys: ["subscriptionId", "source"] },
        "event.free.stored": { level: "info",  requiredKeys: ["subscriptionId"] },
        "event.blocked":     { level: "info",  requiredKeys: ["subscriptionId"] },
        "push.decided":      { level: "info",  requiredKeys: ["subscriptionId", "decision"] },
        "push.sent":         { level: "info",  requiredKeys: ["subscriptionId"] },
        "push.failed":       { level: "error", requiredKeys: ["subscriptionId"] },
        "dedup.checked":     { level: "debug", requiredKeys: ["subscriptionId", "currentLevel", "lastPushedLevel", "deduplicated"] },
        "event.pushed":      { level: "info",  requiredKeys: ["subscriptionId"] },
        "event.notified":    { level: "info",  requiredKeys: ["subscriptionId"] },
        "notify.channel.unknown": { level: "warning", requiredKeys: ["subscriptionId"] },
      },
    },
    "plugin.routing": {
      exportCategory: "lifecycle",
      events: {
        "config.bootstrapped":   { level: "info",    requiredKeys: [] },
        "config.load.error":    { level: "error",   requiredKeys: [] },
        "config.manual.edit.detected": { level: "info", requiredKeys: [] },
        "config.patch.invalid":  { level: "warning", requiredKeys: [] },
        "autorule.inserted":    { level: "info",    requiredKeys: ["ruleId"] },
        "autorule.failed":      { level: "error",   requiredKeys: [] },
      },
    },
    "plugin.reactions": {
      exportCategory: "subscriptions",
      events: {
        "scan.failed":      { level: "error",   requiredKeys: [] },
        "scan.empty":       { level: "debug",   requiredKeys: [] },
        "scan.started":     { level: "info",    requiredKeys: ["pendingCount"] },
        "scan.error":       { level: "error",   requiredKeys: [] },
        "scan.skipped":     { level: "info",    requiredKeys: ["subscriptionId", "pushedAt"] },
        "classified":       { level: "info",    requiredKeys: ["subscriptionId", "status"] },
        "classified.error": { level: "error",   requiredKeys: ["subscriptionId"] },
        "scan.completed":   { level: "info",    requiredKeys: ["classified", "skipped"] },
        "info": { level: "info",  requiredKeys: [] },  // scoped
        "warn": { level: "warning", requiredKeys: [] },  // scoped
        "error": { level: "error", requiredKeys: [] },  // scoped
      },
    },
    "plugin.learner": {
      exportCategory: "lifecycle",
      events: {
        "learner.completed": { level: "info",  requiredKeys: ["durationMs"] },
        "learner.failed":    { level: "error", requiredKeys: [] },
        "learner.skipped":   { level: "info",  requiredKeys: [] },
        "learner.started":   { level: "info",  requiredKeys: ["eventsCount", "reactionsCount", "hasMemory", "hasPreviousProfile"] },
        "profile.updated":   { level: "info",  requiredKeys: ["interruptionTolerance"] },
        "parse.failed":      { level: "warning", requiredKeys: [] },
      },
    },
    "plugin.triage": {
      exportCategory: "lifecycle",
      events: {
        "triage.called":     { level: "info",    requiredKeys: ["subscriptionId", "model"] },
        "triage.result":     { level: "info",    requiredKeys: ["subscriptionId", "decision"] },
        "triage.fallback":   { level: "error",   requiredKeys: ["subscriptionId", "fallbackAction"] },
        "triage.http.error": { level: "warning", requiredKeys: ["status"] },
      },
    },
    "plugin.context": {
      exportCategory: "health",
      fieldLevelMapping: true,
      events: {
        "info": { level: "info",  requiredKeys: [] },  // scoped
        "warn": { level: "warning", requiredKeys: [] },  // scoped
        "error": { level: "error", requiredKeys: [] },  // scoped
      },
    },
    "plugin.patterns": {
      exportCategory: "health",
      fieldLevelMapping: true,
      events: {
        "compute.completed": { level: "info", requiredKeys: ["eventsProcessed"] },
        "info": { level: "info",  requiredKeys: [] },  // scoped
        "warn": { level: "warning", requiredKeys: [] },  // scoped
        "error": { level: "error", requiredKeys: [] },  // scoped
      },
    },
    "plugin.events": {
      exportCategory: "lifecycle",
      events: {
        "info": { level: "info",  requiredKeys: [] },  // scoped
        "warn": { level: "warning", requiredKeys: [] },  // scoped
        "error": { level: "error", requiredKeys: [] },  // scoped
      },
    },
    "plugin.filter": {
      exportCategory: "lifecycle",
      events: {
        "info": { level: "info",  requiredKeys: [] },  // scoped
        "warn": { level: "warning", requiredKeys: [] },  // scoped
        "error": { level: "error", requiredKeys: [] },  // scoped
      },
    },
  },

  keyStrategies: {
    // hmacHost
    host: "hmacHost", target: "hmacHost", endpoint: "hmacHost",
    gateway: "hmacHost", serverName: "hmacHost", ip: "hmacHost",
    // hmacUrlHost
    url: "hmacUrlHost", upstream: "hmacUrlHost", failingURL: "hmacUrlHost",
    "error.failingURL": "hmacUrlHost",
    // hmacId
    cycleId: "hmacId", connectionId: "hmacId", runId: "hmacId",
    sessionId: "hmacId", nodeId: "hmacId", deviceId: "hmacId",
    correlationId: "hmacId", serverId: "hmacId", regionId: "hmacId",
    geofenceId: "hmacId", label: "hmacId", zoneName: "hmacId",
    subscriptionId: "hmacId",
    // drop
    path: "drop", filePath: "drop", description: "drop",
    locale: "drop", timezone: "drop",
    deviceToken: "drop", accessToken: "drop", refreshToken: "drop",
    bearerToken: "drop", tokenSuffix: "drop", password: "drop",
    latitude: "drop", longitude: "drop", lat: "drop", lon: "drop",
    coordinate: "drop", coordinates: "drop",
    heartRate: "drop", steps: "drop", calories: "drop",
    geofenceCoords: "drop", regions: "drop",
    legacyKey: "drop", underlyingDescription: "drop",
    // allowPlain — operational scalars and safe enums
    tier: "allowPlain", smartMode: "allowPlain", phase: "allowPlain",
    success: "allowPlain", durationMs: "allowPlain",
    fieldCount: "allowPlain", changedFields: "allowPlain",
    command: "allowPlain", commandName: "allowPlain", commandType: "allowPlain",
    nodeConnected: "allowPlain", entitlements: "allowPlain",
    version: "allowPlain", appVersion: "allowPlain", buildNumber: "allowPlain",
    systemVersion: "allowPlain", deviceModel: "allowPlain",
    // pipeline / triage / reactions / learner / patterns operational scalars
    // NOTE: `source` is `DeviceEvent.source`, an open string (e.g. "geofence.triggered",
    // "health.steps", arbitrary user-defined sources). HMAC'd to preserve cardinality
    // for debug while denying plaintext exposure of possibly-sensitive source names.
    source: "hmacId",
    decision: "allowPlain",
    status: "allowPlain", model: "allowPlain", fallbackAction: "allowPlain",
    pendingCount: "allowPlain", pushedAt: "allowPlain",
    classified: "allowPlain", skipped: "allowPlain",
    currentLevel: "allowPlain", lastPushedLevel: "allowPlain", deduplicated: "allowPlain",
    eventsCount: "allowPlain", reactionsCount: "allowPlain",
    hasMemory: "allowPlain", hasPreviousProfile: "allowPlain",
    eventsProcessed: "allowPlain",
    interruptionTolerance: "allowPlain",
    // NOTE: `error`, `reason`, `summary` intentionally absent. They carry free-form
    // content (Error.message / LLM output) that can embed URLs, paths, identifiers.
    // Structured error data flows via the error.* carve-out below; reason/summary
    // call sites still emit the field but default-deny drops it at redaction time.
    // error.*
    "error.type":                        "allowPlain",
    "error.message":                     "allowPlain",
    "error.stack":                       "allowPlain",
    "error.cause":                       "allowPlain",
    "error.code":                        "allowPlain",
    "error.domain":                      "allowPlain",
    "error.description":                 "allowPlain",
    "error.underlyingDomain":            "allowPlain",
    "error.underlyingCode":              "allowPlain",
    "error.authMessage":                 "allowPlain",
    "error.authDetailCode":              "allowPlain",
    "error.authRecommendedNextStep":     "allowPlain",
    "error.authCanRetryWithDeviceToken": "allowPlain",
  },

  fieldCategoryImplications: {
    lat: "location", lon: "location", latitude: "location", longitude: "location",
    coordinate: "location", coordinates: "location",
    heartRate: "health", steps: "health", calories: "health",
    zoneName: "geofence", geofenceId: "geofence", geofenceCoords: "geofence",
  },
};

// ---------------------------------------------------------------------------
// redactEntry
// ---------------------------------------------------------------------------

type RawEntry = Omit<PluginLogEntry, "data"> & { data?: Record<string, unknown> };

export type RedactedEntry = {
  timestamp: number;
  level: PluginLogEntry["level"];
  source: string;
  event: string;
  message: string;
  data: string | null;
};

/**
 * Redact a single entry per MANIFEST. Returns null if the entry's base export
 * category is disabled or the source is unknown. Field-implied categories
 * (e.g. `lat` → location) filter individual fields without dropping the entry.
 *
 * Wraps its own work in try/catch: circular refs, JSON.stringify failures, etc.
 * cause the entry to be dropped (return null) rather than aborting the whole
 * export.
 *
 * **Cycle policy:** if the raw `entry.data` contains any cycle — even under a
 * key that would be default-denied — the entire entry is dropped. Rationale:
 * if the producer handed us a corrupted object graph, we don't trust any
 * field on it. This is strictly more conservative than `allowPlain`'s own
 * WeakSet cycle handling, which would otherwise emit `"[circular]"` for
 * cycles reached through allowed keys.
 */
export function redactEntry(entry: RawEntry, settings: ExportSettings, key: Buffer): RedactedEntry | null {
  try {
    const sourceDef = MANIFEST.sources[entry.source];
    if (!sourceDef) return null;

    // Base category gates the whole entry.
    if (!settings[sourceDef.exportCategory]) return null;

    // Per-field strategy and field-implied category filtering.
    let transformed: Record<string, unknown> | null = null;
    if (entry.data) {
      // Pre-flight: if raw data has a cycle anywhere, drop the entry (cycle policy above).
      // Necessary because allowPlain is never called on default-denied keys, so a cycle
      // under such a key wouldn't otherwise reach any stringify.
      JSON.stringify(entry.data);
      transformed = {};
      for (const [k, v] of Object.entries(entry.data)) {
        // Field-implied category: drop this field only (not the whole entry)
        // if its implied category is disabled.
        const impliedCat = MANIFEST.fieldCategoryImplications[k];
        if (impliedCat && !settings[impliedCat]) continue;

        const strategy = MANIFEST.keyStrategies[k];
        if (!strategy) continue;  // default-deny

        let out: unknown;
        switch (strategy) {
          case "hmacHost":    out = typeof v === "string" ? hmacHost(v, key) : undefined; break;
          case "hmacUrlHost": out = typeof v === "string" ? hmacUrlHost(v, key) : undefined; break;
          case "hmacId":      out = typeof v === "string" ? hmacId(v, key) : undefined; break;
          case "allowPlain":  out = allowPlain(v); break;
          case "drop":        out = undefined; break;
        }
        if (out !== undefined) transformed[k] = out;
      }
    }

    return {
      timestamp: entry.timestamp,
      level: entry.level,
      source: entry.source,
      event: entry.event,
      message: entry.message,
      data: transformed === null ? null : JSON.stringify(transformed),
    };
  } catch {
    return null;
  }
}
