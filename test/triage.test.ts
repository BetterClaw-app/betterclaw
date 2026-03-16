import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildTriagePrompt, parseTriageResponse } from "../src/triage.js";
import type { DeviceEvent, TriageProfile } from "../src/types.js";
import { ContextManager } from "../src/context.js";

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

    it("defaults to push on malformed response", () => {
      const result = parseTriageResponse("not json at all");
      expect(result).toEqual({ push: true, reason: "failed to parse triage response", priority: undefined });
    });
  });
});
