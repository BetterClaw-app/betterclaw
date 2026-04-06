import { describe, it, expect } from "vitest";
import { findPushInMessages, buildClassificationPrompt } from "../src/reaction-scanner.js";

describe("findPushInMessages", () => {
  const messages = [
    { role: "user", content: "hey what's up", timestamp: 1740000000 },
    { role: "assistant", content: "Not much! How can I help?", timestamp: 1740000010 },
    { role: "user", content: "[BetterClaw device event] Battery at 15%", timestamp: 1740000060 },
    { role: "assistant", content: "Your battery is getting low.", timestamp: 1740000070 },
    { role: "user", content: "oh thanks, I'll charge it", timestamp: 1740000120 },
    { role: "user", content: "[BetterClaw device event] Geofence exit: Home", timestamp: 1740000300 },
  ];

  it("finds push message by timestamp proximity", () => {
    const result = findPushInMessages(messages, 1740000060, "Battery at 15%");
    expect(result).not.toBeNull();
    expect(result!.pushIndex).toBe(2);
    expect(result!.subsequentMessages).toHaveLength(2);
  });

  it("returns null if no matching message found", () => {
    const result = findPushInMessages(messages, 1740099999, "Nonexistent push");
    expect(result).toBeNull();
  });

  it("stops extracting at next plugin push", () => {
    const result = findPushInMessages(messages, 1740000060, "Battery at 15%");
    expect(result!.subsequentMessages).toHaveLength(2);
    expect(result!.subsequentMessages[1].content).toContain("charge it");
  });

  it("handles content block arrays", () => {
    const blockMessages = [
      { role: "user", content: [{ type: "text", text: "[BetterClaw device event] Battery at 15%" }], timestamp: 1740000060 },
      { role: "assistant", content: "Low battery alert.", timestamp: 1740000070 },
    ];
    const result = findPushInMessages(blockMessages, 1740000060, "Battery at 15%");
    expect(result).not.toBeNull();
  });
});

describe("buildClassificationPrompt", () => {
  it("includes push message and subsequent conversation", () => {
    const prompt = buildClassificationPrompt(
      "Battery at 15% — you're away from home",
      [
        { role: "assistant", content: "Your battery is low and you're not at home." },
        { role: "user", content: "oh thanks, I'll plug in when I get back" },
      ],
    );
    expect(prompt).toContain("Battery at 15%");
    expect(prompt).toContain("plug in");
    expect(prompt).toContain("engaged");
    expect(prompt).toContain("ignored");
    expect(prompt).toContain("unclear");
  });
});
