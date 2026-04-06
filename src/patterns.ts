import type { ContextManager } from "./context.js";
import type { EventLog } from "./events.js";
import type { EventLogEntry, Patterns } from "./types.js";

export class PatternEngine {
  private context: ContextManager;
  private events: EventLog;
  private windowDays: number;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(context: ContextManager, events: EventLog, windowDays: number) {
    this.context = context;
    this.events = events;
    this.windowDays = windowDays;
  }

  startSchedule(analysisHour: number, dailyCallback?: () => Promise<void>): void {
    // Run initial compute on startup
    void this.compute().catch(() => {});

    this.scheduleNext(analysisHour, dailyCallback);
  }

  private scheduleNext(analysisHour: number, dailyCallback?: () => Promise<void>): void {
    const now = new Date();
    const target = new Date(now);
    target.setHours(analysisHour, 0, 0, 0);
    if (target <= now) {
      target.setDate(target.getDate() + 1);
    }
    const msUntil = target.getTime() - now.getTime();

    this.timer = setTimeout(async () => {
      try {
        await this.compute();
        if (dailyCallback) await dailyCallback();
      } catch {
        // ignore errors, will retry next day
      }
      this.scheduleNext(analysisHour, dailyCallback);
    }, msUntil);
    this.timer.unref?.();
  }

  stopSchedule(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async compute(): Promise<Patterns> {
    const windowStart = Date.now() / 1000 - this.windowDays * 86400;
    const entries = await this.events.readSince(windowStart);

    const patterns: Patterns = {
      locationRoutines: computeLocationRoutines(entries),
      healthTrends: computeHealthTrends(entries),
      batteryPatterns: computeBatteryPatterns(entries),
      eventStats: computeEventStats(entries),
      computedAt: Date.now() / 1000,
    };

    await this.context.writePatterns(patterns);

    // Rotate event log if needed
    await this.events.rotate();

    return patterns;
  }
}

export function emptyPatterns(): Patterns {
  return {
    locationRoutines: { weekday: [], weekend: [] },
    healthTrends: {
      stepsAvg7d: null,
      stepsAvg30d: null,
      stepsTrend: null,
      sleepAvg7d: null,
      sleepTrend: null,
      restingHrAvg7d: null,
      restingHrTrend: null,
    },
    batteryPatterns: {
      avgDrainPerHour: null,
      typicalChargeTime: null,
      lowBatteryFrequency: null,
    },
    eventStats: {
      eventsPerDay7d: 0,
      pushesPerDay7d: 0,
      dropRate7d: 0,
      topSources: [],
    },
    computedAt: 0,
  };
}

function computeLocationRoutines(entries: EventLogEntry[]) {
  const geofenceEvents = entries.filter((e) => e.event.source === "geofence.triggered");

  const weekdayZones = new Map<string, { arrives: number[]; leaves: number[] }>();
  const weekendZones = new Map<string, { arrives: number[]; leaves: number[] }>();

  for (const entry of geofenceEvents) {
    const date = new Date(entry.event.firedAt * 1000);
    const isWeekend = date.getDay() === 0 || date.getDay() === 6;
    const hour = date.getHours() + date.getMinutes() / 60;
    const type = entry.event.data.type === 1 ? "enter" : "exit";
    const zones = isWeekend ? weekendZones : weekdayZones;

    const zone = entry.event.metadata?.zoneName ?? "Unknown";
    if (!zones.has(zone)) zones.set(zone, { arrives: [], leaves: [] });
    const z = zones.get(zone)!;

    if (type === "enter") z.arrives.push(hour);
    else z.leaves.push(hour);
  }

  const formatRoutines = (zones: Map<string, { arrives: number[]; leaves: number[] }>) =>
    Array.from(zones.entries()).map(([zone, data]) => ({
      zone,
      typicalArrive: data.arrives.length > 0 ? formatHour(median(data.arrives)) : null,
      typicalLeave: data.leaves.length > 0 ? formatHour(median(data.leaves)) : null,
    }));

  return {
    weekday: formatRoutines(weekdayZones),
    weekend: formatRoutines(weekendZones),
  };
}

function computeHealthTrends(entries: EventLogEntry[]) {
  const healthEvents = entries.filter((e) => e.event.source.startsWith("health"));
  const now = Date.now() / 1000;

  const last7d = healthEvents.filter((e) => e.event.firedAt >= now - 7 * 86400);
  const last30d = healthEvents;

  const stepsValues7d = last7d
    .map((e) => e.event.data.stepsToday)
    .filter((v): v is number => v != null);
  const stepsValues30d = last30d
    .map((e) => e.event.data.stepsToday)
    .filter((v): v is number => v != null);
  const sleepValues7d = last7d
    .map((e) => e.event.data.sleepDurationSeconds)
    .filter((v): v is number => v != null);
  const sleepValues30d = last30d
    .map((e) => e.event.data.sleepDurationSeconds)
    .filter((v): v is number => v != null);
  const rhrValues7d = last7d
    .map((e) => e.event.data.restingHeartRate)
    .filter((v): v is number => v != null);
  const rhrValues30d = last30d
    .map((e) => e.event.data.restingHeartRate)
    .filter((v): v is number => v != null);

  const stepsAvg7d = average(stepsValues7d);
  const stepsAvg30d = average(stepsValues30d);
  const sleepAvg7d = average(sleepValues7d);
  const sleepAvg30d = average(sleepValues30d);
  const rhrAvg7d = average(rhrValues7d);
  const rhrAvg30d = average(rhrValues30d);

  return {
    stepsAvg7d,
    stepsAvg30d,
    stepsTrend: computeTrend(stepsAvg7d, stepsAvg30d),
    sleepAvg7d,
    sleepTrend: computeTrend(sleepAvg7d, sleepAvg30d),
    restingHrAvg7d: rhrAvg7d,
    restingHrTrend: computeInverseTrend(rhrAvg7d, rhrAvg30d),
  };
}

function computeBatteryPatterns(entries: EventLogEntry[]) {
  const lowBatteryEvents = entries.filter(
    (e) =>
      e.event.subscriptionId === "default.battery-low" ||
      e.event.subscriptionId === "default.battery-critical",
  );

  const daySpan =
    entries.length > 0
      ? Math.max(1, (entries[entries.length - 1].timestamp - entries[0].timestamp) / 86400)
      : 1;

  return {
    avgDrainPerHour: null,
    typicalChargeTime: null,
    lowBatteryFrequency: lowBatteryEvents.length / daySpan,
  };
}

function computeEventStats(entries: EventLogEntry[]) {
  const now = Date.now() / 1000;
  const last7d = entries.filter((e) => e.timestamp >= now - 7 * 86400);

  const days = Math.max(1, 7);
  const pushes = last7d.filter((e) => e.decision === "push");
  const drops = last7d.filter((e) => e.decision === "drop");

  const sourceCounts = new Map<string, number>();
  for (const e of last7d) {
    sourceCounts.set(e.event.source, (sourceCounts.get(e.event.source) ?? 0) + 1);
  }
  const topSources = Array.from(sourceCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([source]) => source);

  return {
    eventsPerDay7d: last7d.length / days,
    pushesPerDay7d: pushes.length / days,
    dropRate7d: last7d.length > 0 ? drops.length / last7d.length : 0,
    topSources,
  };
}

// -- Helpers --

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function formatHour(h: number): string {
  const hours = Math.floor(h);
  const mins = Math.round((h - hours) * 60);
  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}

function computeTrend(
  recent: number | null,
  baseline: number | null,
): "improving" | "stable" | "declining" | null {
  if (recent == null || baseline == null) return null;
  const ratio = recent / baseline;
  if (ratio > 1.1) return "improving";
  if (ratio < 0.9) return "declining";
  return "stable";
}

function computeInverseTrend(
  recent: number | null,
  baseline: number | null,
): "improving" | "stable" | "declining" | null {
  if (recent == null || baseline == null) return null;
  const ratio = recent / baseline;
  if (ratio < 0.9) return "improving";
  if (ratio > 1.1) return "declining";
  return "stable";
}
