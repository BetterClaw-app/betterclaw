import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ContextManager } from "../src/context.js";
import type { DeviceEvent, RuntimeState } from "../src/types.js";

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

  describe("runtime state", () => {
    it("defaults to free tier and smartMode off", () => {
      expect(ctx.getRuntimeState()).toEqual({ tier: "free", smartMode: false });
    });

    it("updates runtime state from ping", () => {
      ctx.setRuntimeState({ tier: "premium", smartMode: true });
      expect(ctx.getRuntimeState()).toEqual({ tier: "premium", smartMode: true });
    });

    it("runtime state is not persisted", async () => {
      ctx.setRuntimeState({ tier: "premium", smartMode: true });
      await ctx.save();

      const ctx2 = new ContextManager(tmpDir);
      await ctx2.load();
      expect(ctx2.getRuntimeState()).toEqual({ tier: "free", smartMode: false });
    });
  });
});
