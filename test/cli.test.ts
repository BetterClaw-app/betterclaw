import { describe, it, expect } from "vitest";
import { BETTERCLAW_COMMANDS, mergeAllowCommands, mergeAlsoAllow } from "../src/cli.js";

describe("CLI setup", () => {
  it("exports a non-empty commands list", () => {
    expect(BETTERCLAW_COMMANDS.length).toBeGreaterThan(0);
    // Snapshot the count to catch accidental additions/removals
    expect(BETTERCLAW_COMMANDS).toMatchInlineSnapshot(`
      [
        "clipboard.write",
        "device.battery",
        "geofence.add",
        "geofence.list",
        "geofence.remove",
        "health.distance",
        "health.heartrate",
        "health.hrv",
        "health.restinghr",
        "health.sleep",
        "health.steps",
        "health.summary",
        "health.workouts",
        "location.get",
        "shortcuts.install",
        "shortcuts.run",
        "subscribe.add",
        "subscribe.list",
        "subscribe.pause",
        "subscribe.remove",
        "subscribe.resume",
        "system.capabilities",
        "system.notify",
      ]
    `);
  });

  it("merges without duplicates", () => {
    const existing = ["system.notify", "other.command"];
    const merged = mergeAllowCommands(existing, BETTERCLAW_COMMANDS);
    expect(merged).toContain("system.notify");
    expect(merged).toContain("other.command");
    expect(merged).toContain("location.get");
    const unique = [...new Set(merged)];
    expect(merged.length).toBe(unique.length);
  });

  it("sorts merged result", () => {
    const merged = mergeAllowCommands(["z.command"], BETTERCLAW_COMMANDS);
    expect(merged[0]).toBe(BETTERCLAW_COMMANDS.sort()[0]);
    expect(merged[merged.length - 1]).toBe("z.command");
  });

  it("returns count of newly added commands", () => {
    const existing = ["system.notify", "device.battery"];
    const merged = mergeAllowCommands(existing, BETTERCLAW_COMMANDS);
    const added = merged.length - existing.length;
    // All BetterClaw commands minus the 2 that already exist
    expect(added).toBe(BETTERCLAW_COMMANDS.length - 2);
  });
});

describe("mergeAlsoAllow", () => {
  it("merges two arrays and deduplicates", () => {
    const result = mergeAlsoAllow(["check_tier"], ["get_context", "check_tier"]);
    expect(result).toContain("check_tier");
    expect(result).toContain("get_context");
    expect(result.filter(x => x === "check_tier")).toHaveLength(1);
  });

  it("preserves order (not sorted)", () => {
    const result = mergeAlsoAllow(["z_tool", "a_tool"], ["m_tool"]);
    expect(result).toEqual(["z_tool", "a_tool", "m_tool"]);
  });

  it("handles empty arrays", () => {
    expect(mergeAlsoAllow([], [])).toEqual([]);
    expect(mergeAlsoAllow([], ["a"])).toEqual(["a"]);
    expect(mergeAlsoAllow(["a"], [])).toEqual(["a"]);
  });
});
