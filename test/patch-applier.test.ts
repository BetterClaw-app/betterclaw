import { describe, it, expect } from "vitest";
import { applyPatch } from "../src/routing/patch-applier.js";
import type { RoutingRules, JsonPatchOp } from "../src/routing/types.js";

function baseRules(): RoutingRules {
  return {
    version: 1,
    quietHours: { start: "23:00", end: "07:00", tz: "auto" },
    rules: [
      { id: "battery-critical", match: { source: "device.battery", level: "< 0.1" },
        action: "notify", explicit: true, respectQuietHours: false },
      { id: "default-drop", match: "*", action: "drop", explicit: true },
    ],
  };
}

describe("applyPatch", () => {
  it("applies a simple replace", () => {
    const { result, applied, dropped } = applyPatch(baseRules(), [
      { op: "replace", path: "/rules/0/action", value: "push" },
    ], new Set());
    expect(applied).toHaveLength(1);
    expect(dropped).toHaveLength(0);
    expect(result.rules[0].action).toBe("push");
  });

  it("applies an add to the end of the rules array", () => {
    const patch: JsonPatchOp[] = [{
      op: "add",
      path: "/rules/-",
      value: { id: "new", match: "*", action: "push", explicit: true },
    }];
    const { result } = applyPatch(baseRules(), patch, new Set());
    expect(result.rules).toHaveLength(3);
    expect(result.rules[2].id).toBe("new");
  });

  it("drops ops targeting locked keys", () => {
    const patch: JsonPatchOp[] = [
      { op: "replace", path: "/rules/0/action", value: "drop" },
      { op: "replace", path: "/quietHours/start", value: "22:00" },
    ];
    const { result, applied, dropped } = applyPatch(baseRules(), patch, new Set(["/rules/0/action"]));
    expect(applied.map(a => a.path)).toEqual(["/quietHours/start"]);
    expect(dropped.map(d => d.op.path)).toEqual(["/rules/0/action"]);
    expect(result.rules[0].action).toBe("notify"); // unchanged
    expect(result.quietHours.start).toBe("22:00");
  });

  it("rejects the entire patch when any op is syntactically invalid", () => {
    const patch: JsonPatchOp[] = [
      { op: "replace", path: "/rules/0/action", value: "push" },
      { op: "replace" as const, path: "/nonexistent/path", value: "x" },
    ];
    const { result, applied, dropped } = applyPatch(baseRules(), patch, new Set());
    expect(applied).toHaveLength(0);
    expect(dropped.length).toBeGreaterThan(0);
    expect(result).toEqual(baseRules()); // unchanged
  });
});
