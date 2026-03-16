import { describe, it, expect } from "vitest";
import { BETTERCLAW_COMMANDS, mergeAllowCommands } from "../src/cli.js";

describe("CLI setup", () => {
  it("has 22 commands", () => {
    expect(BETTERCLAW_COMMANDS).toHaveLength(22);
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
    expect(added).toBe(20); // 22 total - 2 already exist
  });
});
