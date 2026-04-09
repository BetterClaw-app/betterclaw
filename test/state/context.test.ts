import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ContextManager } from "../../src/context.js";
import type { DeviceConfig, DeviceEvent, RuntimeState } from "../../src/types.js";

describe("ContextManager", () => {
  let tmpDir: string;
  let ctx: ContextManager;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-test-"));
    ctx = new ContextManager(tmpDir);
  });

  it("starts with empty context", () => {
    const state = ctx.get();
    expect(state.device.battery).toBeNull();
    expect(state.device.location).toBeNull();
    expect(state.meta.eventsToday).toBe(0);
  });

  it("updates battery from event", () => {
    const event: DeviceEvent = {
      subscriptionId: "default.battery-low",
      source: "device.battery",
      data: { level: 0.15, updatedAt: 1740000000 },
      firedAt: 1740000000,
    };
    ctx.updateFromEvent(event);
    const state = ctx.get();
    expect(state.device.battery?.level).toBe(0.15);
    expect(state.meta.eventsToday).toBe(1);
  });

  it("updates health from event", () => {
    const event: DeviceEvent = {
      subscriptionId: "default.daily-health",
      source: "health.summary",
      data: { stepsToday: 8000, heartRateAvg: 72, updatedAt: 1740000000 },
      firedAt: 1740000000,
    };
    ctx.updateFromEvent(event);
    const state = ctx.get();
    expect(state.device.health?.stepsToday).toBe(8000);
    expect(state.device.health?.heartRateAvg).toBe(72);
  });

  it("updates activity from geofence enter", () => {
    const event: DeviceEvent = {
      subscriptionId: "default.geofence",
      source: "geofence.triggered",
      data: { type: 1, latitude: 48.1351, longitude: 11.582, timestamp: 1740000000 },
      firedAt: 1740000000,
    };
    ctx.updateFromEvent(event);
    const state = ctx.get();
    expect(state.device.location?.latitude).toBe(48.1351);
  });

  it("persists and loads context", async () => {
    const event: DeviceEvent = {
      subscriptionId: "default.battery-low",
      source: "device.battery",
      data: { level: 0.15, updatedAt: 1740000000 },
      firedAt: 1740000000,
    };
    ctx.updateFromEvent(event);
    await ctx.save();

    const ctx2 = new ContextManager(tmpDir);
    await ctx2.load();
    expect(ctx2.get().device.battery?.level).toBe(0.15);
  });

  it("updates zone name from geofence enter with metadata", () => {
    const event: DeviceEvent = {
      subscriptionId: "default.geofence",
      source: "geofence.triggered",
      data: { type: 1, latitude: 48.1351, longitude: 11.582, timestamp: 1740000000 },
      metadata: { zoneName: "Home", transitionType: "enter" },
      firedAt: 1740000000,
    };
    ctx.updateFromEvent(event);
    const state = ctx.get();
    expect(state.activity.currentZone).toBe("Home");
    expect(state.activity.isStationary).toBe(true);
  });

  it("clears zone name on geofence exit", () => {
    ctx.updateFromEvent({
      subscriptionId: "default.geofence",
      source: "geofence.triggered",
      data: { type: 1, latitude: 48.1351, longitude: 11.582, timestamp: 1740000000 },
      metadata: { zoneName: "Home", transitionType: "enter" },
      firedAt: 1740000000,
    });
    ctx.updateFromEvent({
      subscriptionId: "default.geofence",
      source: "geofence.triggered",
      data: { type: 0, latitude: 48.1351, longitude: 11.582, timestamp: 1740000100 },
      metadata: { zoneName: "Home", transitionType: "exit" },
      firedAt: 1740000100,
    });
    const state = ctx.get();
    expect(state.activity.currentZone).toBeNull();
    expect(state.activity.isStationary).toBe(false);
  });

  it("resets daily counters on day change", () => {
    ctx.updateFromEvent({
      subscriptionId: "test",
      source: "device.battery",
      data: { level: 0.5, updatedAt: 1740000000 },
      firedAt: 1740000000,
    });
    expect(ctx.get().meta.eventsToday).toBe(1);

    ctx.updateFromEvent({
      subscriptionId: "test",
      source: "device.battery",
      data: { level: 0.4, updatedAt: 1740000100 },
      firedAt: 1740000100,
    });
    expect(ctx.get().meta.eventsToday).toBe(2);

    ctx.updateFromEvent({
      subscriptionId: "test",
      source: "device.battery",
      data: { level: 0.3, updatedAt: 1740090000 },
      firedAt: 1740090000,
    });
    expect(ctx.get().meta.eventsToday).toBe(1);
    expect(ctx.get().meta.pushesToday).toBe(0);
  });

  it("increments push counter", () => {
    ctx.recordPush();
    expect(ctx.get().meta.pushesToday).toBe(1);
    ctx.recordPush();
    expect(ctx.get().meta.pushesToday).toBe(2);
  });

  describe("updatedAt timestamps", () => {
    it("tracks battery updatedAt", () => {
      const event: DeviceEvent = {
        subscriptionId: "default.battery-low",
        source: "device.battery",
        data: { level: 0.15 },
        firedAt: 1740000100,
      };
      ctx.updateFromEvent(event);
      expect(ctx.getTimestamp("battery")).toBe(1740000100);
    });

    it("tracks location updatedAt from geofence", () => {
      const event: DeviceEvent = {
        subscriptionId: "geo-1",
        source: "geofence.triggered",
        data: { latitude: 48.1, longitude: 11.5 },
        metadata: { zoneName: "Home" },
        firedAt: 1740000200,
      };
      ctx.updateFromEvent(event);
      expect(ctx.getTimestamp("location")).toBe(1740000200);
      expect(ctx.getTimestamp("activity")).toBe(1740000200);
    });

    it("tracks health updatedAt", () => {
      const event: DeviceEvent = {
        subscriptionId: "default.daily-health",
        source: "health.summary",
        data: { stepsToday: 5000 },
        firedAt: 1740000300,
      };
      ctx.updateFromEvent(event);
      expect(ctx.getTimestamp("health")).toBe(1740000300);
    });

    it("tracks snapshot updatedAt", () => {
      ctx.applySnapshot({ battery: { level: 0.8, state: "charging", isLowPowerMode: false } }, 1740000400);
      expect(ctx.getTimestamp("lastSnapshot")).toBe(1740000400);
    });
  });

  describe("device config", () => {
    it("returns empty config by default", () => {
      expect(ctx.getDeviceConfig()).toEqual({});
    });

    it("applies device config from RPC", () => {
      ctx.setDeviceConfig({ pushBudgetPerDay: 5 });
      expect(ctx.getDeviceConfig()).toEqual({ pushBudgetPerDay: 5 });
    });

    it("shallow merges config updates", () => {
      ctx.setDeviceConfig({ pushBudgetPerDay: 5 });
      ctx.setDeviceConfig({ proactiveEnabled: false });
      expect(ctx.getDeviceConfig()).toEqual({ pushBudgetPerDay: 5, proactiveEnabled: false });
    });

    it("persists device config across restarts", async () => {
      ctx.setDeviceConfig({ pushBudgetPerDay: 7 });
      await ctx.save();

      const ctx2 = new ContextManager(tmpDir);
      await ctx2.load();
      expect(ctx2.getDeviceConfig()).toEqual({ pushBudgetPerDay: 7 });
    });
  });

  describe("runtime state", () => {
    it("defaults to null tier and smartMode off", () => {
      expect(ctx.getRuntimeState()).toEqual({ tier: null, smartMode: false });
    });

    it("updates runtime state from ping", () => {
      ctx.setRuntimeState({ tier: "premium", smartMode: true });
      expect(ctx.getRuntimeState()).toEqual({ tier: "premium", smartMode: true });
    });

    it("persists tier across load", async () => {
      ctx.setRuntimeState({ tier: "premium", smartMode: true });
      await ctx.save();

      const ctx2 = new ContextManager(tmpDir);
      await ctx2.load();
      expect(ctx2.getRuntimeState().tier).toBe("premium");
      // smartMode is ephemeral — not persisted
      expect(ctx2.getRuntimeState().smartMode).toBe(false);
    });
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
