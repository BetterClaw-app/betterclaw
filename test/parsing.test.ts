// Tests for prompt construction, response parsing, and small helpers used by orchestrators.
import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildTriagePrompt, parseTriageResponse } from "../src/triage.js";
import { buildLearnerPrompt, parseTriageProfile } from "../src/learner.js";
import { findPushInMessages, buildClassificationPrompt, parseClassificationResponse, extractText, isBetterClawPush } from "../src/reaction-scanner.js";
import { errorMessage } from "../src/types.js";
import type { DeviceEvent, TriageProfile, EventLogEntry, ReactionEntry } from "../src/types.js";
import { ContextManager } from "../src/context.js";

// --- From triage.test.ts ---

describe("triage", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-triage-"));
  });

  const profile: TriageProfile = {
    eventPreferences: { "geofence.triggered": "context-dependent" },
    lifeContext: "Normal work week",
    interruptionTolerance: "normal",
    timePreferences: { quietHoursStart: 22, quietHoursEnd: 7 },
    sensitivityThresholds: { batteryLevel: 0.15 },
    locationRules: { Office: "drop", Home: "context-dependent" },
    summary: "User cares about battery when away, ignores routine geofence at Office",
    computedAt: 1740000000,
  };

  const event: DeviceEvent = {
    subscriptionId: "custom-1",
    source: "custom.event",
    data: { value: 42 },
    firedAt: 1740000100,
  };

  describe("buildTriagePrompt", () => {
    it("includes triage profile summary", () => {
      const ctx = new ContextManager(tmpDir);
      const prompt = buildTriagePrompt(event, ctx, profile);
      expect(prompt).toContain("User cares about battery when away");
    });

    it("includes event data", () => {
      const ctx = new ContextManager(tmpDir);
      const prompt = buildTriagePrompt(event, ctx, profile);
      expect(prompt).toContain("custom.event");
      expect(prompt).toContain("custom-1");
    });

    it("includes device context", () => {
      const ctx = new ContextManager(tmpDir);
      ctx.updateFromEvent({
        subscriptionId: "bat",
        source: "device.battery",
        data: { level: 0.5 },
        firedAt: 1740000050,
      });
      const prompt = buildTriagePrompt(event, ctx, profile);
      expect(prompt).toContain("50%");
    });

    it("handles null triage profile gracefully", () => {
      const ctx = new ContextManager(tmpDir);
      const prompt = buildTriagePrompt(event, ctx, null);
      expect(prompt).toContain("custom.event");
      expect(prompt).toContain("No triage profile available");
    });

    it("includes budget context in triage prompt", () => {
      const ctx = new ContextManager("/tmp/test-triage-budget");
      const budgetEvent: DeviceEvent = {
        subscriptionId: "test.event",
        source: "test",
        data: { value: 1 },
        firedAt: Date.now() / 1000,
      };
      const prompt = buildTriagePrompt(budgetEvent, ctx, null, { budgetUsed: 7, budgetTotal: 10 });
      expect(prompt).toContain("7 of 10 pushes used today");
    });
  });

  describe("parseTriageResponse", () => {
    it("parses valid JSON response", () => {
      const result = parseTriageResponse('{"push": true, "reason": "relevant", "priority": "normal"}');
      expect(result).toEqual({ push: true, reason: "relevant", priority: "normal" });
    });

    it("extracts JSON from markdown code fence", () => {
      const result = parseTriageResponse('```json\n{"push": false, "reason": "routine"}\n```');
      expect(result).toEqual({ push: false, reason: "routine", priority: undefined });
    });

    it("defaults to drop on malformed response", () => {
      const result = parseTriageResponse("not json at all");
      expect(result).toEqual({ push: false, reason: "failed to parse triage response \u2014 defaulting to drop", priority: undefined });
    });

    it("fails closed on parse error", () => {
      const result = parseTriageResponse("not valid json at all");
      expect(result.push).toBe(false);
      expect(result.reason).toContain("failed to parse");
    });

    it("returns fallback on empty string", () => {
      const result = parseTriageResponse("");
      expect(result.push).toBe(false);
      expect(result.reason).toBe("failed to parse triage response \u2014 defaulting to drop");
    });

    it("handles partial JSON (truncated)", () => {
      const result = parseTriageResponse('{"push": true, "reas');
      expect(result.push).toBe(false);
      expect(result.reason).toContain("failed to parse");
    });

    it("strips nested markdown fences", () => {
      const result = parseTriageResponse('```json\n{"push": true, "reason": "important event"}\n```');
      expect(result.push).toBe(true);
      expect(result.reason).toBe("important event");
    });

    it("ignores extra fields gracefully", () => {
      const result = parseTriageResponse('{"push": true, "reason": "test", "extra": 42, "nested": {"a": 1}}');
      expect(result.push).toBe(true);
      expect(result.reason).toBe("test");
    });

    it("treats non-true push value as false", () => {
      const result = parseTriageResponse('{"push": "yes", "reason": "test"}');
      expect(result.push).toBe(false);
    });

    it("maps valid priority values", () => {
      const result = parseTriageResponse('{"push": true, "reason": "test", "priority": "high"}');
      expect(result.priority).toBe("high");
    });

    it("drops invalid priority values", () => {
      const result = parseTriageResponse('{"push": true, "reason": "test", "priority": "urgent"}');
      expect(result.priority).toBeUndefined();
    });
  });
});

// --- From learner.test.ts (prompt + parsing only, NOT readMemorySummary) ---

describe("learner", () => {
  describe("buildLearnerPrompt", () => {
    it("includes memory summary when available", () => {
      const prompt = buildLearnerPrompt({
        memorySummary: "# March 16\nBusy day.",
        recentEvents: [],
        reactions: [],
        previousProfile: null,
        patternsJson: "{}",
      });
      expect(prompt).toContain("Busy day");
    });

    it("includes event decisions", () => {
      const events: EventLogEntry[] = [
        {
          event: { subscriptionId: "geo-1", source: "geofence.triggered", data: {}, firedAt: 1740000100 },
          decision: "push",
          reason: "geofence always pushes",
          timestamp: 1740000100,
        },
      ];
      const prompt = buildLearnerPrompt({
        memorySummary: null,
        recentEvents: events,
        reactions: [],
        previousProfile: null,
        patternsJson: "{}",
      });
      expect(prompt).toContain("geofence.triggered");
      expect(prompt).toContain("push");
    });

    it("includes reaction data", () => {
      const reactions: ReactionEntry[] = [
        {
          subscriptionId: "geo-1",
          source: "geofence.triggered",
          pushedAt: 1740000100,
          messageSummary: "You arrived at Office",
          status: "ignored",
          classifiedAt: 1740000200,
          classificationReason: "User did not open app",
        },
      ];
      const prompt = buildLearnerPrompt({
        memorySummary: null,
        recentEvents: [],
        reactions,
        previousProfile: null,
        patternsJson: "{}",
      });
      expect(prompt).toContain("ignored");
    });

    it("includes previous profile for continuity", () => {
      const prev: TriageProfile = {
        interruptionTolerance: "low",
        summary: "User on vacation, low tolerance",
        computedAt: 1740000000,
      };
      const prompt = buildLearnerPrompt({
        memorySummary: null,
        recentEvents: [],
        reactions: [],
        previousProfile: prev,
        patternsJson: "{}",
      });
      expect(prompt).toContain("vacation");
    });

    it("includes 'No events' section when recentEvents is empty", () => {
      const prompt = buildLearnerPrompt({
        memorySummary: null,
        recentEvents: [],
        reactions: [],
        previousProfile: null,
        patternsJson: "{}",
      });
      expect(prompt).toContain("No events in the last 24 hours");
    });

    it("includes 'No push reaction data' section when reactions is empty", () => {
      const prompt = buildLearnerPrompt({
        memorySummary: "User was at home",
        recentEvents: [],
        reactions: [],
        previousProfile: null,
        patternsJson: "{}",
      });
      expect(prompt).toContain("No push reaction data available");
    });

    it("includes 'No previous profile' section on first run", () => {
      const prompt = buildLearnerPrompt({
        memorySummary: null,
        recentEvents: [],
        reactions: [],
        previousProfile: null,
        patternsJson: "{}",
      });
      expect(prompt).toContain("No previous profile");
      expect(prompt).toContain("first analysis");
    });

    it("includes previous profile summary when present", () => {
      const prompt = buildLearnerPrompt({
        memorySummary: null,
        recentEvents: [],
        reactions: [],
        previousProfile: { summary: "Likes battery alerts", interruptionTolerance: "high", computedAt: 1000 },
        patternsJson: "{}",
      });
      expect(prompt).toContain("Likes battery alerts");
      expect(prompt).toContain("high");
    });

    it("includes memory summary when present", () => {
      const prompt = buildLearnerPrompt({
        memorySummary: "User went to the gym at 7am",
        recentEvents: [],
        reactions: [],
        previousProfile: null,
        patternsJson: "{}",
      });
      expect(prompt).toContain("User went to the gym at 7am");
    });
  });

  describe("parseTriageProfile", () => {
    it("parses valid profile JSON", () => {
      const json = JSON.stringify({
        summary: "User is busy, drop routine events",
        interruptionTolerance: "low",
      });
      const result = parseTriageProfile(json);
      expect(result).not.toBeNull();
      expect(result!.summary).toBe("User is busy, drop routine events");
      expect(result!.interruptionTolerance).toBe("low");
      expect(result!.computedAt).toBeGreaterThan(0);
    });

    it("ignores extra fields from old schema", () => {
      const json = JSON.stringify({
        summary: "User is busy",
        interruptionTolerance: "normal",
        eventPreferences: { "geofence.triggered": "drop" },
        lifeContext: "busy work week",
        timePreferences: { quietHoursStart: 22 },
        sensitivityThresholds: { batteryLevel: 0.15 },
        locationRules: { Office: "drop" },
      });
      const result = parseTriageProfile(json);
      expect(result).not.toBeNull();
      expect(result).toEqual({
        summary: "User is busy",
        interruptionTolerance: "normal",
        computedAt: expect.any(Number),
      });
    });

    it("returns null on malformed JSON", () => {
      const result = parseTriageProfile("not json");
      expect(result).toBeNull();
    });

    it("returns null on empty string", () => {
      expect(parseTriageProfile("")).toBeNull();
    });

    it("returns null on null-like input", () => {
      expect(parseTriageProfile("null")).toBeNull();
    });

    it("returns null when summary is missing", () => {
      expect(parseTriageProfile('{"interruptionTolerance": "normal"}')).toBeNull();
    });

    it("returns null when interruptionTolerance is missing", () => {
      expect(parseTriageProfile('{"summary": "test user"}')).toBeNull();
    });

    it("defaults invalid tolerance to normal", () => {
      const result = parseTriageProfile('{"summary": "test", "interruptionTolerance": "extreme"}');
      expect(result).not.toBeNull();
      expect(result!.interruptionTolerance).toBe("normal");
    });

    it("uses current time when computedAt is missing", () => {
      const before = Date.now() / 1000;
      const result = parseTriageProfile('{"summary": "test", "interruptionTolerance": "low"}');
      expect(result).not.toBeNull();
      expect(result!.computedAt).toBeGreaterThanOrEqual(before);
    });
  });
});

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
