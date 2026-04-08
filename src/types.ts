/** Minimal logger interface for plugin modules. Compatible with the SDK's PluginLogger. */
export type PluginModuleLogger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

// -- Incoming event from iOS --

export interface DeviceEvent {
  subscriptionId: string;
  source: string;
  data: Record<string, number>;
  metadata?: Record<string, string>;
  firedAt: number;
}

// -- Context state (context.json) --

export interface BatteryState {
  level: number;
  state: string;
  isLowPowerMode: boolean;
  updatedAt: number;
}

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
    battery: BatteryState | null;
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
  decision: "push" | "drop" | "stored" | "free_stored" | "blocked" | "error";
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
  batteryPatterns: {
    avgDrainPerHour: number | null;
    typicalChargeTime: string | null;
    lowBatteryFrequency: number | null;
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
  calibrationDays: number;
}

// Triage profile produced by daily learning agent
export interface TriageProfile {
  summary: string;              // 1-2 sentence description of what the user cares about
  interruptionTolerance: "low" | "normal" | "high";
  computedAt: number;           // epoch seconds
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
}