import { describe, it, expect, beforeEach } from "vitest";
import { RulesEngine } from "../src/filter.js";
import { ContextManager } from "../src/context.js";
import type { DeviceEvent } from "../src/types.js";

describe("RulesEngine", () => {
  let rules: RulesEngine;
  let emptyContext: ReturnType<typeof ContextManager.empty>;

  beforeEach(() => {
    rules = new RulesEngine(10, {
      "default.battery-low": 3600,
      "default.battery-critical": 1800,
      "default.daily-health": 82800,
      "default.geofence": 300,
    });
    emptyContext = ContextManager.empty();
  });

  it("always pushes debug events", () => {
    const event: DeviceEvent = {
      subscriptionId: "default.battery-low",
      source: "device.battery",
      data: { level: 0.15, _debugFired: 1.0 },
      firedAt: 1740000000,
    };
    const decision = rules.evaluate(event, emptyContext);
    expect(decision.action).toBe("push");
    expect(decision.reason).toContain("debug");
  });

  it("always pushes critical battery", () => {
    const event: DeviceEvent = {
      subscriptionId: "default.battery-critical",
      source: "device.battery",
      data: { level: 0.08 },
      firedAt: 1740000000,
    };
    const decision = rules.evaluate(event, emptyContext);
    expect(decision.action).toBe("push");
  });

  it("always pushes geofence events", () => {
    const event: DeviceEvent = {
      subscriptionId: "default.geofence",
      source: "geofence.triggered",
      data: { type: 1, latitude: 48, longitude: 11, timestamp: 1740000000 },
      firedAt: 1740000000,
    };
    const decision = rules.evaluate(event, emptyContext);
    expect(decision.action).toBe("push");
  });

  it("deduplicates within cooldown window", () => {
    const event: DeviceEvent = {
      subscriptionId: "default.battery-low",
      source: "device.battery",
      data: { level: 0.15 },
      firedAt: 1740000000,
    };
    rules.recordFired("default.battery-low", 1740000000);

    const event2 = { ...event, firedAt: 1740000000 + 1800 }; // 30 min later (< 1hr cooldown)
    const decision = rules.evaluate(event2, emptyContext);
    expect(decision.action).toBe("drop");
    expect(decision.reason).toContain("dedup");
  });

  it("allows after cooldown expires", () => {
    rules.recordFired("default.battery-low", 1740000000);
    const event: DeviceEvent = {
      subscriptionId: "default.battery-low",
      source: "device.battery",
      data: { level: 0.12 },
      firedAt: 1740000000 + 3700, // > 1hr cooldown
    };
    const decision = rules.evaluate(event, emptyContext);
    expect(decision.action).toBe("push");
  });

  it("pushes battery-low when level changed since last push", () => {
    const ctx = ContextManager.empty();
    // Simulate: context already updated to 0.18 (pipeline updates context first)
    ctx.device.battery = { level: 0.18, state: "unplugged", isLowPowerMode: false, updatedAt: 1740000100 };

    // First battery-low push at level 0.25 — no previous push, should push
    const first = rules.evaluate(
      { subscriptionId: "default.battery-low", source: "device.battery", data: { level: 0.25 }, firedAt: 1740000100 },
      ctx,
    );
    expect(first.action).toBe("push");

    // Record the push with the battery level
    rules.recordFired("default.battery-low", 1740000100, { level: 0.25 });

    // Second event with same level — should drop (dedup)
    const second = rules.evaluate(
      { subscriptionId: "default.battery-low", source: "device.battery", data: { level: 0.25 }, firedAt: 1740004000 },
      ctx,
    );
    expect(second.action).toBe("drop");
    expect(second.reason).toContain("unchanged");

    // Third event with different level — should push
    const third = rules.evaluate(
      { subscriptionId: "default.battery-low", source: "device.battery", data: { level: 0.18 }, firedAt: 1740008000 },
      ctx,
    );
    expect(third.action).toBe("push");
  });

  it("restoreCooldowns restores battery level and deduplicates", () => {
    const ctx = ContextManager.empty();

    // Simulate restoring from event log: a previous push at level 0.15
    rules.restoreCooldowns([
      { subscriptionId: "default.battery-low", firedAt: 1740000000, data: { level: 0.15 } },
    ]);

    // Event with same level — should drop (dedup against restored level)
    const result = rules.evaluate(
      { subscriptionId: "default.battery-low", source: "device.battery", data: { level: 0.15 }, firedAt: 1740010000 },
      ctx,
    );
    expect(result.action).toBe("drop");
    expect(result.reason).toContain("unchanged");
  });

  it("drops daily health outside morning window", () => {
    const noonEpoch = new Date("2026-02-19T12:00:00Z").getTime() / 1000;
    const event: DeviceEvent = {
      subscriptionId: "default.daily-health",
      source: "health.summary",
      data: { stepsToday: 5000 },
      firedAt: noonEpoch,
    };
    const decision = rules.evaluate(event, emptyContext);
    expect(decision.action).toBe("drop");
  });

  it("drops when push budget is exhausted (configurable)", () => {
    const customRules = new RulesEngine(5);
    const context = ContextManager.empty();
    context.meta.pushesToday = 5;
    const event: DeviceEvent = {
      subscriptionId: "custom.something",
      source: "custom.source",
      data: { value: 42 },
      firedAt: 1740000000,
    };
    const decision = customRules.evaluate(event, context);
    expect(decision.action).toBe("drop");
    expect(decision.reason).toContain("budget");
  });

  it("allows when under custom budget", () => {
    const customRules = new RulesEngine(20);
    const context = ContextManager.empty();
    context.meta.pushesToday = 15;
    const event: DeviceEvent = {
      subscriptionId: "custom.something",
      source: "custom.source",
      data: { value: 42 },
      firedAt: 1740000000,
    };
    const decision = customRules.evaluate(event, context);
    expect(decision.action).toBe("ambiguous");
  });

  it("returns ambiguous for unknown events", () => {
    const event: DeviceEvent = {
      subscriptionId: "custom.something",
      source: "custom.source",
      data: { value: 42 },
      firedAt: 1740000000,
    };
    const decision = rules.evaluate(event, emptyContext);
    expect(decision.action).toBe("ambiguous");
  });
});
