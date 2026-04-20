import { describe, it, expect, beforeEach } from "vitest";
import { RulesEngine } from "../src/filter.js";
import { ContextManager } from "../src/context.js";
import type { DeviceEvent } from "../src/types.js";

describe("RulesEngine", () => {
  let rules: RulesEngine;
  let emptyContext: ReturnType<typeof ContextManager.empty>;

  beforeEach(() => {
    rules = new RulesEngine(10, {
      "default.daily-health": 82800,
      "default.geofence": 300,
    });
    emptyContext = ContextManager.empty();
  });

  it("always pushes debug events", () => {
    const event: DeviceEvent = {
      subscriptionId: "default.daily-health",
      source: "health.daily",
      data: { stepsToday: 8000, _debugFired: 1.0 },
      firedAt: 1740000000,
    };
    const decision = rules.evaluate(event, emptyContext);
    expect(decision.action).toBe("push");
    expect(decision.reason).toContain("debug");
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
      subscriptionId: "default.daily-health",
      source: "health.daily",
      data: { stepsToday: 5000 },
      firedAt: 1740000000,
    };
    rules.recordFired("default.daily-health", 1740000000);

    const event2 = { ...event, firedAt: 1740000000 + 3600 }; // 1hr later (< 82800s cooldown)
    const decision = rules.evaluate(event2, emptyContext);
    expect(decision.action).toBe("drop");
    expect(decision.reason).toContain("dedup");
  });

  it("allows after cooldown expires", () => {
    rules.recordFired("default.daily-health", 1740000000);
    const event: DeviceEvent = {
      subscriptionId: "default.daily-health",
      source: "health.daily",
      data: { stepsToday: 6000 },
      firedAt: 1740000000 + 82900, // > 23hr cooldown
    };
    const decision = rules.evaluate(event, emptyContext);
    // daily-health falls through to ambiguous (no always-push branch); proves cooldown released
    expect(decision.action).toBe("ambiguous");
  });

  it("restoreCooldowns restores timestamps and deduplicates", () => {
    const ctx = ContextManager.empty();

    // Simulate restoring from event log: a previous push
    rules.restoreCooldowns([
      { subscriptionId: "default.daily-health", firedAt: 1740000000 },
    ]);

    // Event within cooldown — should drop
    const result = rules.evaluate(
      { subscriptionId: "default.daily-health", source: "health.daily", data: { stepsToday: 5000 }, firedAt: 1740010000 },
      ctx,
    );
    expect(result.action).toBe("drop");
    expect(result.reason).toContain("dedup");
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
