import * as fs from "node:fs/promises";
import * as path from "node:path";
import { noopLogger, type DeviceConfig, type DeviceContext, type DeviceEvent, type Patterns, type PluginModuleLogger, type RuntimeState } from "./types.js";

const CONTEXT_FILE = "context.json";
const PATTERNS_FILE = "patterns.json";

export class ContextManager {
  private contextPath: string;
  private patternsPath: string;
  private context: DeviceContext;
  private runtimeState: RuntimeState = { tier: null, smartMode: false };
  private timestamps: Record<string, number> = {};
  private deviceConfig: DeviceConfig = {};
  private logger: PluginModuleLogger;

  constructor(stateDir: string, logger?: PluginModuleLogger) {
    this.contextPath = path.join(stateDir, CONTEXT_FILE);
    this.patternsPath = path.join(stateDir, PATTERNS_FILE);
    this.context = ContextManager.empty();
    this.logger = logger ?? noopLogger;
  }

  static empty(): DeviceContext {
    return {
      device: { battery: null, location: null, health: null },
      activity: {
        currentZone: null,
        zoneEnteredAt: null,
        lastTransition: null,
        isStationary: true,
        stationarySince: null,
      },
      meta: {
        lastEventAt: 0,
        eventsToday: 0,
        lastAgentPushAt: 0,
        pushesToday: 0,
      },
    };
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.contextPath, "utf8");
      const parsed = JSON.parse(raw);
      this.timestamps = parsed._timestamps ?? {};
      delete parsed._timestamps;
      const savedTier = parsed._tier;
      delete parsed._tier;
      if (savedTier === "free" || savedTier === "premium") {
        this.runtimeState = { ...this.runtimeState, tier: savedTier };
      }
      this.context = parsed as DeviceContext;
    } catch {
      this.context = ContextManager.empty();
      this.timestamps = {};
    }
    try {
      const configPath = path.join(path.dirname(this.contextPath), "device-config.json");
      const rawConfig = await fs.readFile(configPath, "utf8");
      this.deviceConfig = JSON.parse(rawConfig) as DeviceConfig;
    } catch {
      this.deviceConfig = {};
    }
  }

  get(): DeviceContext {
    return this.context;
  }

  getTimestamp(field: string): number | undefined {
    return this.timestamps[field];
  }

  /** Returns age of each device data section in seconds, or null if no data */
  getDataAge(): { battery: number | null; location: number | null; health: number | null } {
    const now = Date.now() / 1000;
    return {
      battery: this.timestamps.battery != null ? Math.round(now - this.timestamps.battery) : null,
      location: this.timestamps.location != null ? Math.round(now - this.timestamps.location) : null,
      health: this.timestamps.health != null ? Math.round(now - this.timestamps.health) : null,
    };
  }

  async save(): Promise<boolean> {
    try {
      await fs.mkdir(path.dirname(this.contextPath), { recursive: true });
      const data = { ...this.context, _timestamps: this.timestamps, _tier: this.runtimeState.tier };
      await fs.writeFile(this.contextPath, JSON.stringify(data, null, 2) + "\n", "utf8");
      const configPath = path.join(path.dirname(this.contextPath), "device-config.json");
      await fs.writeFile(configPath, JSON.stringify(this.deviceConfig, null, 2) + "\n", "utf8");
      return true;
    } catch (err) {
      this.logger.error(`context save failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  updateFromEvent(event: DeviceEvent): void {
    const now = event.firedAt;
    const data = event.data;

    // Reset daily counters at local midnight
    const lastDate = new Date(this.context.meta.lastEventAt * 1000);
    const currentDate = new Date(now * 1000);
    const lastDay = `${lastDate.getFullYear()}-${String(lastDate.getMonth() + 1).padStart(2, "0")}-${String(lastDate.getDate()).padStart(2, "0")}`;
    const currentDay = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, "0")}-${String(currentDate.getDate()).padStart(2, "0")}`;
    if (lastDay !== currentDay && this.context.meta.lastEventAt > 0) {
      this.context.meta.eventsToday = 0;
      this.context.meta.pushesToday = 0;
    }

    this.context.meta.lastEventAt = now;
    this.context.meta.eventsToday++;

    switch (event.source) {
      case "device.battery":
        this.context.device.battery = {
          level: data.level ?? this.context.device.battery?.level ?? 0,
          state: this.context.device.battery?.state ?? "unknown",
          isLowPowerMode: (data.isLowPowerMode ?? 0) === 1,
          updatedAt: data.updatedAt ?? now,
        };
        this.timestamps.battery = event.firedAt;
        break;

      case "geofence.triggered": {
        const type = data.type === 1 ? "enter" : "exit";
        const zoneName = event.metadata?.zoneName ?? null;
        const prevZone = this.context.activity.currentZone;

        if (type === "enter") {
          this.context.activity.lastTransition = {
            from: prevZone,
            to: zoneName,
            at: now,
          };
          this.context.activity.currentZone = zoneName;
          this.context.activity.zoneEnteredAt = now;
          this.context.activity.isStationary = true;
          this.context.activity.stationarySince = now;
        } else if (type === "exit") {
          this.context.activity.lastTransition = {
            from: prevZone,
            to: null,
            at: now,
          };
          this.context.activity.currentZone = null;
          this.context.activity.zoneEnteredAt = null;
          this.context.activity.isStationary = false;
          this.context.activity.stationarySince = null;
        }

        this.context.device.location = {
          latitude: data.latitude ?? this.context.device.location?.latitude ?? 0,
          longitude: data.longitude ?? this.context.device.location?.longitude ?? 0,
          horizontalAccuracy: this.context.device.location?.horizontalAccuracy ?? 0,
          label: this.context.activity.currentZone,
          updatedAt: data.timestamp ?? now,
        };
        this.timestamps.location = event.firedAt;
        this.timestamps.activity = event.firedAt;
        break;
      }

      default:
        if (event.source.startsWith("health")) {
          this.context.device.health = {
            stepsToday: data.stepsToday ?? this.context.device.health?.stepsToday ?? null,
            distanceMeters: data.distanceMeters ?? this.context.device.health?.distanceMeters ?? null,
            heartRateAvg: data.heartRateAvg ?? this.context.device.health?.heartRateAvg ?? null,
            restingHeartRate: data.restingHeartRate ?? this.context.device.health?.restingHeartRate ?? null,
            hrv: data.hrv ?? this.context.device.health?.hrv ?? null,
            activeEnergyKcal: data.activeEnergyKcal ?? this.context.device.health?.activeEnergyKcal ?? null,
            sleepDurationSeconds: data.sleepDurationSeconds ?? this.context.device.health?.sleepDurationSeconds ?? null,
            updatedAt: data.updatedAt ?? now,
          };
          this.timestamps.health = event.firedAt;
        }
        break;
    }
  }

  applySnapshot(snapshot: {
    battery?: { level: number; state: string; isLowPowerMode: boolean };
    location?: { latitude: number; longitude: number };
    health?: {
      stepsToday?: number; distanceMeters?: number; heartRateAvg?: number;
      restingHeartRate?: number; hrv?: number; activeEnergyKcal?: number;
      sleepDurationSeconds?: number;
    };
    geofence?: { type: string; zoneName: string; latitude: number; longitude: number };
  }, timestamp?: number): void {
    const now = timestamp ?? Date.now() / 1000;

    if (snapshot.battery) {
      this.context.device.battery = {
        level: snapshot.battery.level,
        state: snapshot.battery.state,
        isLowPowerMode: snapshot.battery.isLowPowerMode,
        updatedAt: now,
      };
      this.timestamps.battery = now;
    }

    if (snapshot.location) {
      this.context.device.location = {
        latitude: snapshot.location.latitude,
        longitude: snapshot.location.longitude,
        horizontalAccuracy: 0,
        label: this.context.activity.currentZone,
        updatedAt: now,
      };
      this.timestamps.location = now;
    }

    if (snapshot.health) {
      this.context.device.health = {
        stepsToday: snapshot.health.stepsToday ?? null,
        distanceMeters: snapshot.health.distanceMeters ?? null,
        heartRateAvg: snapshot.health.heartRateAvg ?? null,
        restingHeartRate: snapshot.health.restingHeartRate ?? null,
        hrv: snapshot.health.hrv ?? null,
        activeEnergyKcal: snapshot.health.activeEnergyKcal ?? null,
        sleepDurationSeconds: snapshot.health.sleepDurationSeconds ?? null,
        updatedAt: now,
      };
      this.timestamps.health = now;
    }

    if (snapshot.geofence) {
      const prevZone = this.context.activity.currentZone;
      if (snapshot.geofence.type === "enter") {
        this.context.activity.currentZone = snapshot.geofence.zoneName;
        this.context.activity.zoneEnteredAt = now;
        this.context.activity.isStationary = true;
        this.context.activity.stationarySince = now;
        this.context.activity.lastTransition = { from: prevZone, to: snapshot.geofence.zoneName, at: now };
      } else {
        this.context.activity.currentZone = null;
        this.context.activity.zoneEnteredAt = null;
        this.context.activity.isStationary = false;
        this.context.activity.stationarySince = null;
        this.context.activity.lastTransition = { from: prevZone, to: null, at: now };
      }

      if (this.context.device.location) {
        this.context.device.location.label = this.context.activity.currentZone;
      }
    }

    this.timestamps.lastSnapshot = now;
  }

  getRuntimeState(): RuntimeState {
    return { ...this.runtimeState };
  }

  setRuntimeState(state: RuntimeState): void {
    this.runtimeState = { ...state };
  }

  getDeviceConfig(): DeviceConfig {
    return { ...this.deviceConfig };
  }

  setDeviceConfig(update: DeviceConfig): void {
    this.deviceConfig = { ...this.deviceConfig, ...update };
  }

  recordPush(): void {
    this.context.meta.lastAgentPushAt = Date.now() / 1000;
    this.context.meta.pushesToday++;
  }

  async readPatterns(): Promise<Patterns | null> {
    try {
      const raw = await fs.readFile(this.patternsPath, "utf8");
      return JSON.parse(raw) as Patterns;
    } catch {
      return null;
    }
  }

  async writePatterns(patterns: Patterns): Promise<boolean> {
    try {
      await fs.writeFile(this.patternsPath, JSON.stringify(patterns, null, 2) + "\n", "utf8");
      return true;
    } catch (err) {
      this.logger.error(`patterns write failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }
}
