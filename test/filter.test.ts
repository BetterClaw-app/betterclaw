import { describe, it, expect, beforeEach } from "vitest";
import { RulesEngine } from "../src/filter.js";
import { ContextManager } from "../src/context.js";
import type { DeviceEvent } from "../src/types.js";

describe("RulesEngine", () => {
  let rules: RulesEngine;
  let emptyContext: ReturnType<typeof ContextManager.empty>;

  beforeEach(() => {
    rules = new RulesEngine();
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
