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

    // 1hr later (< 82800s cooldown). Dedup now measures gateway time, so
    // pass `now` explicitly rather than relying on event.firedAt.
    const decision = rules.evaluate(event, emptyContext, undefined, 1740000000 + 3600);
    expect(decision.action).toBe("drop");
    expect(decision.reason).toContain("dedup");
  });

  it("allows after cooldown expires", () => {
    rules.recordFired("default.daily-health", 1740000000);
    const event: DeviceEvent = {
      subscriptionId: "default.daily-health",
      source: "health.daily",
      data: { stepsToday: 6000 },
      firedAt: 1740000000 + 82900,
    };
    // > 23hr cooldown — pass explicit now (gateway time) because dedup no
    // longer reads event.firedAt.
    const decision = rules.evaluate(event, emptyContext, undefined, 1740000000 + 82900);
    // daily-health falls through to ambiguous (no always-push branch); proves cooldown released
    expect(decision.action).toBe("ambiguous");
  });

  it("dedup is stable when iOS wall-clock jumps backwards", () => {
    // Regression test for "fired -253s ago" bug. Previously dedup compared
    // two iOS timestamps; an NTP correction that pulled the device clock
    // backwards produced a negative delta, which passes "< cooldown" and
    // silently dropped legitimate re-fires.
    rules.recordFired("default.daily-health", 1740000000);
    const event: DeviceEvent = {
      subscriptionId: "default.daily-health",
      source: "health.daily",
      data: { stepsToday: 5000 },
      firedAt: 1740000000 - 253, // iOS clock jumped back 253s
    };
    // Gateway time is 1s after the last recorded fire — well within cooldown.
    const decision = rules.evaluate(event, emptyContext, undefined, 1740000000 + 1);
    expect(decision.action).toBe("drop");
    expect(decision.reason).toContain("fired 1s ago");
  });

  it("restoreCooldowns restores timestamps and deduplicates", () => {
    const ctx = ContextManager.empty();

    // Simulate restoring from event log: a previous push recorded at gateway time.
    rules.restoreCooldowns([
      { subscriptionId: "default.daily-health", at: 1740000000 },
    ]);

    // Event within cooldown — should drop. `now` is the gateway time of the
    // new evaluation, 10000s after the restored fire.
    const result = rules.evaluate(
      { subscriptionId: "default.daily-health", source: "health.daily", data: { stepsToday: 5000 }, firedAt: 1740010000 },
      ctx,
      undefined,
      1740010000,
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
