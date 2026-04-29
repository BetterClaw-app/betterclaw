import { describe, expect, it } from "vitest";
import { resolveActiveBetterClawIosNodeId } from "../src/node-hygiene.js";

describe("resolveActiveBetterClawIosNodeId", () => {
  it("returns the newest connected BetterClaw iOS node id", () => {
    const result = resolveActiveBetterClawIosNodeId([
      { nodeId: "old", clientId: "openclaw-ios", platform: "iOS", deviceFamily: "iPhone", commands: ["location.get"], connectedAtMs: 10 },
      { nodeId: "new", clientId: "openclaw-ios", platform: "iOS", deviceFamily: "iPhone", commands: ["location.get"], connectedAtMs: 20 },
    ]);

    expect(result).toBe("new");
  });

  it("ignores non-iOS and non-BetterClaw nodes", () => {
    const result = resolveActiveBetterClawIosNodeId([
      { nodeId: "mac", clientId: "openclaw-mac", platform: "macOS", connectedAtMs: 30 },
      { nodeId: "ios", clientId: "openclaw-ios", displayName: "Max iPhone", commands: ["location.get"], connectedAtMs: 20 },
    ]);

    expect(result).toBe("ios");
  });

  it("falls back to deviceId when nodeId is absent", () => {
    expect(resolveActiveBetterClawIosNodeId([
      { deviceId: "device-a", clientId: "openclaw-ios", platform: "iOS", commands: ["location.get"] },
    ])).toBe("device-a");
  });

  it("ignores foreground-only iOS clients that cannot run node commands", () => {
    const result = resolveActiveBetterClawIosNodeId([
      {
        nodeId: "foreground",
        clientId: "openclaw-ios",
        platform: "iOS",
        deviceFamily: "iPhone",
        roles: ["operator"],
        connectedAtMs: 30,
      },
      {
        nodeId: "node",
        clientId: "openclaw-ios",
        platform: "iOS",
        deviceFamily: "iPhone",
        commands: ["location.get"],
        connectedAtMs: 20,
      },
    ]);

    expect(result).toBe("node");
  });

  it("returns null when no connected BetterClaw iOS node is present", () => {
    expect(resolveActiveBetterClawIosNodeId([{ nodeId: "mac", platform: "macOS" }])).toBeNull();
  });
});
