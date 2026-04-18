// Tests for prompt construction, response parsing, and small helpers used by orchestrators.
import { describe, it, expect } from "vitest";
import { findPushInMessages, buildClassificationPrompt, parseClassificationResponse, extractText, isBetterClawPush } from "../src/reaction-scanner.js";
import { errorMessage } from "../src/types.js";

// Coverage for buildTriagePrompt / parseTriageResponse lives in test/orchestrators/triage.test.ts
// Coverage for buildLearnerPrompt / parseLearnerOutput lives in test/orchestrators/learner.test.ts

// --- From reaction-scanner.test.ts ---

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
      "Battery at 15% \u2014 you're away from home",
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

describe("parseClassificationResponse", () => {
  it("parses valid JSON with classification", () => {
    const result = parseClassificationResponse('{"status": "engaged", "reason": "user replied"}');
    expect(result.status).toBe("engaged");
    expect(result.reason).toBe("user replied");
  });

  it("returns unclear on malformed JSON", () => {
    const result = parseClassificationResponse("not json at all");
    expect(result.status).toBe("unclear");
    expect(result.reason).toBe("failed to parse LLM response");
  });

  it("returns unclear when status field is missing", () => {
    const result = parseClassificationResponse('{"reason": "no status here"}');
    expect(result.status).toBe("unclear");
    expect(result.reason).toBe("no status here");
  });

  it("maps invalid status value to unclear", () => {
    const result = parseClassificationResponse('{"status": "bananas", "reason": "test"}');
    expect(result.status).toBe("unclear");
    expect(result.reason).toBe("test");
  });

  it("strips markdown code fences before parsing", () => {
    const result = parseClassificationResponse('```json\n{"status": "ignored", "reason": "no reply"}\n```');
    expect(result.status).toBe("ignored");
    expect(result.reason).toBe("no reply");
  });

  it("defaults reason when reason field is not a string", () => {
    const result = parseClassificationResponse('{"status": "engaged", "reason": 42}');
    expect(result.status).toBe("engaged");
    expect(result.reason).toBe("no reason provided");
  });
});

describe("errorMessage", () => {
  it("extracts message from Error instance", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("returns string input as-is", () => {
    expect(errorMessage("oops")).toBe("oops");
  });

  it("stringifies plain object via String()", () => {
    expect(errorMessage({ code: 42 })).toBe("[object Object]");
  });

  it("converts null to 'null'", () => {
    expect(errorMessage(null)).toBe("null");
  });

  it("converts undefined to 'undefined'", () => {
    expect(errorMessage(undefined)).toBe("undefined");
  });

  it("converts number to string", () => {
    expect(errorMessage(123)).toBe("123");
  });
});

describe("extractText", () => {
  it("returns string content directly", () => {
    expect(extractText("hello world")).toBe("hello world");
  });

  it("joins text blocks from content-block array", () => {
    const blocks = [
      { type: "text", text: "block1" },
      { type: "text", text: "block2" },
    ];
    expect(extractText(blocks)).toBe("block1block2");
  });

  it("filters out non-text blocks", () => {
    const blocks = [
      { type: "text", text: "keep" },
      { type: "image", url: "http://example.com" },
      { type: "text", text: "this" },
    ];
    expect(extractText(blocks)).toBe("keepthis");
  });

  it("returns empty string for number input", () => {
    expect(extractText(42)).toBe("");
  });

  it("returns empty string for null input", () => {
    expect(extractText(null)).toBe("");
  });

  it("returns empty string for undefined input", () => {
    expect(extractText(undefined)).toBe("");
  });

  it("handles block with missing text property", () => {
    const blocks = [{ type: "text" }];
    expect(extractText(blocks)).toBe("");
  });
});

describe("isBetterClawPush", () => {
  it("returns true when text contains BetterClaw device event marker", () => {
    expect(isBetterClawPush("[BetterClaw device event — processed by context plugin]\n\nBattery at 15%")).toBe(true);
  });

  it("returns false for debug prefix (does not contain the marker)", () => {
    expect(isBetterClawPush("[DEBUG test event fired manually from BetterClaw iOS debug menu]")).toBe(false);
  });

  it("returns true for partial marker presence", () => {
    expect(isBetterClawPush("prefix [BetterClaw device event suffix")).toBe(true);
  });

  it("returns false for non-matching message", () => {
    expect(isBetterClawPush("regular user message about battery")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isBetterClawPush("")).toBe(false);
  });

  it("returns false for similar but not exact marker", () => {
    expect(isBetterClawPush("[BetterClaw notification")).toBe(false);
  });
});
