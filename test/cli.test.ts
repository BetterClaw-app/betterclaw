import { describe, it, expect } from "vitest";
import { BETTERCLAW_COMMANDS, mergeAllowCommands, mergeAlsoAllow } from "../src/cli.js";

describe("CLI setup", () => {
  it("has 23 commands", () => {
    expect(BETTERCLAW_COMMANDS).toHaveLength(23);
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
    expect(added).toBe(21); // 23 total - 2 already exist
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
