import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { EventLog } from "../src/events.js";
import { ContextManager } from "../src/context.js";
import type { EventLogEntry } from "../src/types.js";

function makeEntry(i: number, decision: "push" | "drop" | "defer" = "push"): EventLogEntry {
  return {
    event: {
      subscriptionId: `sub-${i}`,
      source: "device.battery",
      data: { level: 0.5 },
      firedAt: 1740000000 + i,
    },
    decision,
    reason: `reason-${i}`,
    timestamp: 1740000000 + i,
  };
}

describe("EventLog.readRecent", () => {
  let tmpDir: string;
  let log: EventLog;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-ctx-rpc-"));
    log = new EventLog(tmpDir);
  });

  it("returns last N entries when log has more than limit", async () => {
    for (let i = 0; i < 30; i++) {
      await log.append(makeEntry(i));
    }

    const recent = await log.readRecent(10);
    expect(recent).toHaveLength(10);
    expect(recent[0].event.subscriptionId).toBe("sub-20");
    expect(recent[9].event.subscriptionId).toBe("sub-29");
  });

  it("returns all entries when log has fewer than limit", async () => {
    for (let i = 0; i < 5; i++) {
      await log.append(makeEntry(i));
    }

    const recent = await log.readRecent(20);
    expect(recent).toHaveLength(5);
    expect(recent[0].event.subscriptionId).toBe("sub-0");
    expect(recent[4].event.subscriptionId).toBe("sub-4");
  });

  it("returns empty array for empty log", async () => {
    const recent = await log.readRecent(20);
    expect(recent).toHaveLength(0);
  });

  it("uses default limit of 20", async () => {
    for (let i = 0; i < 30; i++) {
      await log.append(makeEntry(i));
    }

    const recent = await log.readRecent();
    expect(recent).toHaveLength(20);
    expect(recent[0].event.subscriptionId).toBe("sub-10");
  });
});

describe("ContextManager activity state", () => {
  let tmpDir: string;
  let ctx: ContextManager;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-ctx-rpc-"));
    ctx = new ContextManager(tmpDir);
  });

  it("returns default activity state", () => {
    const state = ctx.get();
    expect(state.activity.currentZone).toBeNull();
    expect(state.activity.isStationary).toBe(true);
    expect(state.activity.lastTransition).toBeNull();
    expect(state.activity.zoneEnteredAt).toBeNull();
    expect(state.activity.stationarySince).toBeNull();
  });

  it("reflects activity after geofence enter", () => {
    ctx.updateFromEvent({
      subscriptionId: "default.geofence",
      source: "geofence.triggered",
      data: { type: 1, latitude: 48.1351, longitude: 11.582, timestamp: 1740000000 },
      metadata: { zoneName: "Office", transitionType: "enter" },
      firedAt: 1740000000,
    });

    const state = ctx.get();
    expect(state.activity.currentZone).toBe("Office");
    expect(state.activity.zoneEnteredAt).toBe(1740000000);
    expect(state.activity.isStationary).toBe(true);
    expect(state.activity.lastTransition).toEqual({
      from: null,
      to: "Office",
      at: 1740000000,
    });
  });

  it("returns null patterns when no patterns file exists", async () => {
    const patterns = await ctx.readPatterns();
    expect(patterns).toBeNull();
  });
});

describe("ContextManager.applySnapshot", () => {
  let tmpDir: string;
  let ctx: ContextManager;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-snapshot-"));
    ctx = new ContextManager(tmpDir);
  });

  it("applies battery snapshot", () => {
    ctx.applySnapshot({ battery: { level: 0.85, state: "charging", isLowPowerMode: false } });

    const state = ctx.get();
    expect(state.device.battery).not.toBeNull();
    expect(state.device.battery!.level).toBe(0.85);
    expect(state.device.battery!.state).toBe("charging");
    expect(state.device.battery!.isLowPowerMode).toBe(false);
    expect(state.device.battery!.updatedAt).toBeGreaterThan(0);
  });

  it("applies geofence enter and sets zone", () => {
    ctx.applySnapshot({
      geofence: { type: "enter", zoneName: "Home", latitude: 48.1, longitude: 11.5 },
    });

    const state = ctx.get();
    expect(state.activity.currentZone).toBe("Home");
    expect(state.activity.zoneEnteredAt).toBeGreaterThan(0);
    expect(state.activity.isStationary).toBe(true);
    expect(state.activity.lastTransition).toEqual({
      from: null,
      to: "Home",
      at: expect.any(Number),
    });
  });

  it("applies geofence exit and clears zone", () => {
    // First enter a zone
    ctx.applySnapshot({
      geofence: { type: "enter", zoneName: "Office", latitude: 48.1, longitude: 11.5 },
    });
    // Then exit
    ctx.applySnapshot({
      geofence: { type: "exit", zoneName: "Office", latitude: 48.1, longitude: 11.5 },
    });

    const state = ctx.get();
    expect(state.activity.currentZone).toBeNull();
    expect(state.activity.zoneEnteredAt).toBeNull();
    expect(state.activity.isStationary).toBe(false);
    expect(state.activity.lastTransition).toEqual({
      from: "Office",
      to: null,
      at: expect.any(Number),
    });
  });

  it("applies partial snapshot (battery only, no health/location/geofence)", () => {
    ctx.applySnapshot({ battery: { level: 0.42, state: "unplugged", isLowPowerMode: true } });

    const state = ctx.get();
    expect(state.device.battery!.level).toBe(0.42);
    expect(state.device.location).toBeNull();
    expect(state.device.health).toBeNull();
    expect(state.activity.currentZone).toBeNull();
  });

  it("applies health snapshot", () => {
    ctx.applySnapshot({
      health: {
        stepsToday: 8500,
        distanceMeters: 6200,
        heartRateAvg: 72,
        restingHeartRate: 58,
        hrv: 45,
        activeEnergyKcal: 320,
        sleepDurationSeconds: 27000,
      },
    });

    const state = ctx.get();
    expect(state.device.health).not.toBeNull();
    expect(state.device.health!.stepsToday).toBe(8500);
    expect(state.device.health!.distanceMeters).toBe(6200);
    expect(state.device.health!.heartRateAvg).toBe(72);
    expect(state.device.health!.restingHeartRate).toBe(58);
    expect(state.device.health!.hrv).toBe(45);
    expect(state.device.health!.activeEnergyKcal).toBe(320);
    expect(state.device.health!.sleepDurationSeconds).toBe(27000);
    expect(state.device.health!.updatedAt).toBeGreaterThan(0);
  });
});
