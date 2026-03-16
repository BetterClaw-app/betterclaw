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
          idempotencyKey: "key-1",
          subscriptionId: "geo-1",
          source: "geofence.triggered",
          pushedAt: 1740000100,
          engaged: false,
          checkedAt: 1740000200,
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
        eventPreferences: {},
        lifeContext: "vacation",
        interruptionTolerance: "low",
        timePreferences: {},
        sensitivityThresholds: {},
        locationRules: {},
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
        eventPreferences: { "geofence.triggered": "drop" },
        lifeContext: "busy work week",
        interruptionTolerance: "low",
        timePreferences: { quietHoursStart: 22, quietHoursEnd: 7 },
        sensitivityThresholds: { batteryLevel: 0.15 },
        locationRules: { Office: "drop" },
        summary: "User is busy, drop routine events",
      });
      const result = parseTriageProfile(json);
      expect(result).not.toBeNull();
      expect(result!.lifeContext).toBe("busy work week");
      expect(result!.computedAt).toBeGreaterThan(0);
    });

    it("returns null on malformed JSON", () => {
      const result = parseTriageProfile("not json");
      expect(result).toBeNull();
    });
  });
});
