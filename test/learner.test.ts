import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildLearnerPrompt, parseTriageProfile, readMemorySummary } from "../src/learner.js";
import type { EventLogEntry, TriageProfile, ReactionEntry } from "../src/types.js";

describe("learner", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-learner-"));
  });

  describe("readMemorySummary", () => {
    it("reads today's memory file", async () => {
      const memDir = path.join(tmpDir, "memory");
      await fs.mkdir(memDir, { recursive: true });
      await fs.writeFile(path.join(memDir, "2026-03-16.md"), "# March 16\n\nBusy day at work.");

      const content = await readMemorySummary(tmpDir, new Date("2026-03-16T10:00:00"));
      expect(content).toContain("Busy day at work");
    });

    it("returns null if no memory file exists", async () => {
      const content = await readMemorySummary(tmpDir, new Date("2026-03-16T10:00:00"));
      expect(content).toBeNull();
    });
  });

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
