import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PatternEngine, emptyPatterns } from "../../src/patterns.js";
import { ContextManager } from "../../src/context.js";
import { EventLog } from "../../src/events.js";

describe("PatternEngine", () => {
  it("computes empty patterns from empty log", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-patterns-"));
    const ctx = new ContextManager(tmpDir);
    const log = new EventLog(tmpDir);
    const engine = new PatternEngine(ctx, log, 14);

    const patterns = await engine.compute();
    expect(patterns.eventStats.eventsPerDay7d).toBe(0);
    expect(patterns.healthTrends.stepsAvg7d).toBeNull();
    expect(patterns.computedAt).toBeGreaterThan(0);
  });

  it("computes event stats from log entries", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-patterns-"));
    const ctx = new ContextManager(tmpDir);
    const log = new EventLog(tmpDir);

    const now = Date.now() / 1000;
    for (let i = 0; i < 7; i++) {
      await log.append({
        event: {
          subscriptionId: "test",
          source: "device.battery",
          data: { level: 0.5 },
          firedAt: now - i * 86400,
        },
        decision: i % 2 === 0 ? "push" : "drop",
        reason: "test",
        timestamp: now - i * 86400,
      });
    }

    const engine = new PatternEngine(ctx, log, 14);
    const patterns = await engine.compute();

    expect(patterns.eventStats.eventsPerDay7d).toBe(1);
    expect(patterns.eventStats.topSources).toContain("device.battery");
  });

  it("computes sleep and resting HR trends", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-trends-"));
    const ctx = new ContextManager(tmpDir);
    const log = new EventLog(tmpDir);

    const now = Date.now() / 1000;
    for (let i = 0; i < 30; i++) {
      const isRecent = i < 7;
      await log.append({
        event: {
          subscriptionId: "default.daily-health",
          source: "health.summary",
          data: {
            stepsToday: isRecent ? 10000 : 7000,
            sleepDurationSeconds: isRecent ? 28800 : 25200,
            restingHeartRate: isRecent ? 55 : 65,
            updatedAt: now - i * 86400,
          },
          firedAt: now - i * 86400,
        },
        decision: "push",
        reason: "test",
        timestamp: now - i * 86400,
      });
    }

    const engine = new PatternEngine(ctx, log, 30);
    const patterns = await engine.compute();

    expect(patterns.healthTrends.sleepAvg7d).toBeCloseTo(28800, -1);
    expect(patterns.healthTrends.sleepTrend).toBe("improving");
    expect(patterns.healthTrends.restingHrAvg7d).toBeCloseTo(55, 0);
    expect(patterns.healthTrends.restingHrTrend).toBe("improving");
  });

  it("computes location routines with zone names from metadata", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-patterns-"));
    const ctx = new ContextManager(tmpDir);
    const log = new EventLog(tmpDir);

    const now = Date.now() / 1000;
    for (let i = 0; i < 5; i++) {
        const dayOffset = i * 86400;
        await log.append({
            event: {
                subscriptionId: "default.geofence",
                source: "geofence.triggered",
                data: { type: 1, latitude: 48, longitude: 11, timestamp: now - dayOffset + 64800 },
                metadata: { zoneName: "Home" },
                firedAt: now - dayOffset + 64800,
            },
            decision: "push",
            reason: "test",
            timestamp: now - dayOffset + 64800,
        });
        await log.append({
            event: {
                subscriptionId: "default.geofence",
                source: "geofence.triggered",
                data: { type: 0, latitude: 48, longitude: 11, timestamp: now - dayOffset + 28800 },
                metadata: { zoneName: "Home" },
                firedAt: now - dayOffset + 28800,
            },
            decision: "push",
            reason: "test",
            timestamp: now - dayOffset + 28800,
        });
    }

    const engine = new PatternEngine(ctx, log, 14);
    const patterns = await engine.compute();

    const homeRoutine = patterns.locationRoutines.weekday.find(r => r.zone === "Home")
        ?? patterns.locationRoutines.weekend.find(r => r.zone === "Home");
    expect(homeRoutine).toBeDefined();
  });

  it("emptyPatterns returns valid structure", () => {
    const p = emptyPatterns();
    expect(p.healthTrends.stepsAvg7d).toBeNull();
    expect(p.computedAt).toBe(0);
  });
});
