import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { DeviceContext, DeviceEvent, Patterns } from "./types.js";

const CONTEXT_FILE = "context.json";
const PATTERNS_FILE = "patterns.json";

export class ContextManager {
  private contextPath: string;
  private patternsPath: string;
  private context: DeviceContext;

  constructor(stateDir: string) {
    this.contextPath = path.join(stateDir, CONTEXT_FILE);
    this.patternsPath = path.join(stateDir, PATTERNS_FILE);
    this.context = ContextManager.empty();
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
      this.context = JSON.parse(raw) as DeviceContext;
    } catch {
      this.context = ContextManager.empty();
    }
  }

  get(): DeviceContext {
    return this.context;
  }

  async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.contextPath), { recursive: true });
    await fs.writeFile(this.contextPath, JSON.stringify(this.context, null, 2) + "\n", "utf8");
  }

  updateFromEvent(event: DeviceEvent): void {
    const now = event.firedAt;
    const data = event.data;

    // Reset daily counters at midnight UTC
    const lastDay = Math.floor(this.context.meta.lastEventAt / 86400);
    const currentDay = Math.floor(now / 86400);
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
  }): void {
    const now = Date.now() / 1000;

    if (snapshot.battery) {
      this.context.device.battery = {
        level: snapshot.battery.level,
        state: snapshot.battery.state,
        isLowPowerMode: snapshot.battery.isLowPowerMode,
        updatedAt: now,
      };
    }

    if (snapshot.location) {
      this.context.device.location = {
        latitude: snapshot.location.latitude,
        longitude: snapshot.location.longitude,
        horizontalAccuracy: 0,
        label: this.context.activity.currentZone,
        updatedAt: now,
      };
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

  async writePatterns(patterns: Patterns): Promise<void> {
    await fs.mkdir(path.dirname(this.patternsPath), { recursive: true });
    await fs.writeFile(this.patternsPath, JSON.stringify(patterns, null, 2) + "\n", "utf8");
  }
}
