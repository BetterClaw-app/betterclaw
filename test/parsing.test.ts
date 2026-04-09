// Tests for prompt construction, response parsing, and small helpers used by orchestrators.
import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildTriagePrompt, parseTriageResponse } from "../src/triage.js";
import { buildLearnerPrompt, parseTriageProfile } from "../src/learner.js";
import { findPushInMessages, buildClassificationPrompt } from "../src/reaction-scanner.js";
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
