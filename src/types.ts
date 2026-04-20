/**
 * Minimal logger interface for plugin modules. Compatible with the SDK's PluginLogger.
 *
 * All stateful modules (EventLog, ContextManager, ReactionTracker, PatternEngine) accept
 * an optional PluginModuleLogger in their constructor. Write operations (save, append,
 * rotate, writePatterns) catch errors internally, log via this logger, and return boolean.
 * Callers do NOT need try/catch around write calls — the module handles it.
 */
export type PluginModuleLogger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

/** Shared noop logger for modules and tests. Use when logging is not needed. */
export const noopLogger: PluginModuleLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** Extract error message from unknown catch parameter. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Structured log entry for diagnostic JSONL files. */
export interface PluginLogEntry {
  timestamp: number;
  level: "debug" | "info" | "notice" | "warning" | "error" | "critical";
  source: string;
  event: string;
  message: string;
  data?: Record<string, unknown>;
}

// -- Incoming event from iOS --

export interface DeviceEvent {
  subscriptionId: string;
  source: string;
  data: Record<string, number>;
  metadata?: Record<string, string>;
  firedAt: number;
}

// -- Context state (context.json) --

export interface LocationState {
  latitude: number;
  longitude: number;
  horizontalAccuracy: number;
  label: string | null;
  updatedAt: number;
}

export interface HealthState {
  stepsToday: number | null;
  distanceMeters: number | null;
  heartRateAvg: number | null;
  restingHeartRate: number | null;
  hrv: number | null;
  activeEnergyKcal: number | null;
  sleepDurationSeconds: number | null;
  updatedAt: number;
}

export interface ActivityState {
  currentZone: string | null;
  zoneEnteredAt: number | null;
  lastTransition: {
    from: string | null;
    to: string | null;
    at: number;
  } | null;
  isStationary: boolean;
  stationarySince: number | null;
}

export interface ContextMeta {
  lastEventAt: number;
  eventsToday: number;
  lastAgentPushAt: number;
  pushesToday: number;
}

export interface DeviceContext {
  device: {
    location: LocationState | null;
    health: HealthState | null;
  };
  activity: ActivityState;
  meta: ContextMeta;
}

// -- Filter decisions --

export type FilterDecision =
  | { action: "push"; reason: string }
  | { action: "drop"; reason: string }
  | { action: "ambiguous"; reason: string };

// -- Event log entry --

export interface EventLogEntry {
  event: DeviceEvent;
  decision: "push" | "drop" | "stored" | "free_stored" | "blocked" | "error" | "notify";
  reason: string;
  timestamp: number;
}

// -- Patterns --

export interface LocationRoutine {
  zone: string;
  typicalLeave: string | null;
  typicalArrive: string | null;
}

export interface Patterns {
  locationRoutines: {
    weekday: LocationRoutine[];
    weekend: LocationRoutine[];
  };
  healthTrends: {
    stepsAvg7d: number | null;
    stepsAvg30d: number | null;
    stepsTrend: "improving" | "stable" | "declining" | null;
    sleepAvg7d: number | null;
    sleepTrend: "improving" | "stable" | "declining" | null;
    restingHrAvg7d: number | null;
    restingHrTrend: "improving" | "stable" | "declining" | null;
  };
  eventStats: {
    eventsPerDay7d: number;
    pushesPerDay7d: number;
    dropRate7d: number;
    topSources: string[];
  };
  computedAt: number;
}

// -- Plugin config --

export interface PluginConfig {
  triageModel: string;
  triageApiBase?: string;
  pushBudgetPerDay: number;
  patternWindowDays: number;
  proactiveEnabled: boolean;
  analysisHour: number;
  deduplicationCooldowns: Record<string, number>;
  defaultCooldown: number;
}

// Reaction tracking for pushed events
export type ReactionStatus = "pending" | "engaged" | "ignored" | "unclear";

export interface ReactionEntry {
  subscriptionId: string;
  source: string;
  pushedAt: number;
  messageSummary: string;       // first ~100 chars of the pushed message
  status: ReactionStatus;
  classifiedAt?: number;        // epoch when LLM classified
  classificationReason?: string; // one-line reason from classifier
}

// Per-device config from betterclaw.config RPC
export interface DeviceConfig {
  pushBudgetPerDay?: number;
  proactiveEnabled?: boolean;
}

export interface RuntimeState {
  tier: "free" | "premium" | null;
  smartMode: boolean;
  tz?: string;
}