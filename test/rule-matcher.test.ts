// test/rule-matcher.test.ts
import { describe, it, expect } from "vitest";
import { matchEvent } from "../src/routing/rule-matcher.js";
import type { Rule } from "../src/routing/types.js";
import type { DeviceEvent } from "../src/types.js";

function ev(source: string, data: Record<string, number> = {}, metadata: Record<string, string> = {}): DeviceEvent {
  return { subscriptionId: "test", source, data, metadata, firedAt: 1776000000 };
}

describe("matchEvent", () => {
  it("returns null when no rule matches", () => {
    const rules: Rule[] = [
      { id: "a", match: { source: "health.steps" }, action: "push", explicit: true },
    ];
    expect(matchEvent(ev("device.battery"), rules)).toBeNull();
  });

  it("matches exact source", () => {
    const rules: Rule[] = [
      { id: "b", match: { source: "device.battery" }, action: "notify", explicit: true },
    ];
    const m = matchEvent(ev("device.battery"), rules);
    expect(m).not.toBeNull();
    expect(m!.action).toBe("notify");
    expect(m!.index).toBe(0);
  });

  it("matches geofence type 'enter' → data.type === 1", () => {
    const rules: Rule[] = [
      { id: "c", match: { source: "geofence.triggered", type: "enter" }, action: "notify", explicit: true },
    ];
    expect(matchEvent(ev("geofence.triggered", { type: 1 }), rules)).not.toBeNull();
    expect(matchEvent(ev("geofence.triggered", { type: 0 }), rules)).toBeNull();
  });

  it("matches geofenceLabel against metadata.zoneName", () => {
    const rules: Rule[] = [
      { id: "d", match: { source: "geofence.triggered", geofenceLabel: "home" }, action: "notify", explicit: true },
    ];
    expect(matchEvent(ev("geofence.triggered", { type: 1 }, { zoneName: "home" }), rules)).not.toBeNull();
    expect(matchEvent(ev("geofence.triggered", { type: 1 }, { zoneName: "work" }), rules)).toBeNull();
  });

  it("matches numeric level comparisons", () => {
    const rules: Rule[] = [
      { id: "e", match: { source: "device.battery", level: "< 0.2" }, action: "notify", explicit: true },
    ];
    expect(matchEvent(ev("device.battery", { level: 0.15 }), rules)).not.toBeNull();
    expect(matchEvent(ev("device.battery", { level: 0.25 }), rules)).toBeNull();
    expect(matchEvent(ev("device.battery", { level: 0.2 }), rules)).toBeNull(); // strict <
  });

  it("supports all comparison operators", () => {
    const cases: Array<[string, number, boolean]> = [
      ["< 0.2", 0.1, true],   ["< 0.2", 0.2, false],
      ["<= 0.2", 0.2, true],  ["<= 0.2", 0.21, false],
      ["> 0.8", 0.9, true],   ["> 0.8", 0.8, false],
      [">= 0.8", 0.8, true],  [">= 0.8", 0.79, false],
      ["== 0.5", 0.5, true],  ["== 0.5", 0.51, false],
    ];
    for (const [expr, val, expected] of cases) {
      const rules: Rule[] = [
        { id: "x", match: { source: "s", level: expr }, action: "notify", explicit: true },
      ];
      const result = matchEvent(ev("s", { level: val }), rules) !== null;
      expect(result, `expr=${expr} val=${val}`).toBe(expected);
    }
  });

  it("wildcard match matches any event", () => {
    const rules: Rule[] = [
      { id: "w", match: "*", action: "drop", explicit: true },
    ];
    expect(matchEvent(ev("anything"), rules)!.action).toBe("drop");
  });

  it("first match wins (rule ordering)", () => {
    const rules: Rule[] = [
      { id: "a", match: { source: "device.battery" }, action: "notify", explicit: true },
      { id: "b", match: { source: "device.battery" }, action: "drop", explicit: true },
    ];
    const m = matchEvent(ev("device.battery"), rules);
    expect(m!.rule.id).toBe("a");
  });

  it("returns the action from the matched rule", () => {
    const rules: Rule[] = [
      { id: "r", match: "*", action: "push", explicit: false },
    ];
    expect(matchEvent(ev("x"), rules)!.action).toBe("push");
  });
});
