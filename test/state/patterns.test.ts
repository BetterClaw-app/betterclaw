import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PatternEngine, emptyPatterns } from "../../src/patterns.js";
import { ContextManager } from "../../src/context.js";
import { EventLog } from "../../src/events.js";
import { makeTmpDir } from "../helpers.js";

describe("PatternEngine", () => {
  it("computes empty patterns from empty log", async () => {
    const tmpDir = await makeTmpDir("betterclaw-patterns-");
    const ctx = new ContextManager(tmpDir);
    const log = new EventLog(tmpDir);
    const engine = new PatternEngine(ctx, log, 14);

    const patterns = await engine.compute();
    expect(patterns.eventStats.eventsPerDay7d).toBe(0);
    expect(patterns.healthTrends.stepsAvg7d).toBeNull();
    expect(patterns.computedAt).toBeGreaterThan(0);
  });

  it("computes event stats from log entries", async () => {
    const tmpDir = await makeTmpDir("betterclaw-patterns-");
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
    const tmpDir = await makeTmpDir("betterclaw-trends-");
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
    const tmpDir = await makeTmpDir("betterclaw-patterns-");
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

describe("PatternEngine.compute", () => {
  let tmpDir: string;
  let ctx: ContextManager;
  let log: EventLog;

  beforeEach(async () => {
    tmpDir = await makeTmpDir("betterclaw-patcomp-");
    ctx = new ContextManager(tmpDir);
    log = new EventLog(tmpDir);
  });

  it("computes health trends from health events", async () => {
    const now = Date.now() / 1000;
    for (let i = 0; i < 7; i++) {
      await log.append({
        event: {
          subscriptionId: "default.daily-health",
          source: "health.summary",
          data: { stepsToday: 9000, restingHeartRate: 60, updatedAt: now - i * 86400 },
          firedAt: now - i * 86400,
        },
        decision: "push",
        reason: "test",
        timestamp: now - i * 86400,
      });
    }

    const engine = new PatternEngine(ctx, log, 14);
    const patterns = await engine.compute();
    expect(patterns.healthTrends.stepsAvg7d).toBeCloseTo(9000, 0);
    expect(patterns.healthTrends.restingHrAvg7d).toBeCloseTo(60, 0);
  });

  it("computes location routines from geofence events", async () => {
    const now = Date.now() / 1000;
    // Add weekday geofence events
    for (let i = 0; i < 5; i++) {
      const dayOffset = i * 86400;
      await log.append({
        event: {
          subscriptionId: "geo",
          source: "geofence.triggered",
          data: { type: 1, latitude: 48, longitude: 11, timestamp: now - dayOffset + 32400 },
          metadata: { zoneName: "Office" },
          firedAt: now - dayOffset + 32400,
        },
        decision: "push",
        reason: "test",
        timestamp: now - dayOffset + 32400,
      });
    }

    const engine = new PatternEngine(ctx, log, 14);
    const patterns = await engine.compute();
    const allRoutines = [...patterns.locationRoutines.weekday, ...patterns.locationRoutines.weekend];
    const officeRoutine = allRoutines.find((r) => r.zone === "Office");
    expect(officeRoutine).toBeDefined();
    expect(officeRoutine!.typicalArrive).not.toBeNull();
  });

  it("computes battery patterns from battery events", async () => {
    const now = Date.now() / 1000;
    for (let i = 0; i < 10; i++) {
      await log.append({
        event: {
          subscriptionId: i < 3 ? "default.battery-low" : "default.battery",
          source: "device.battery",
          data: { level: 0.1 + i * 0.08 },
          firedAt: now - i * 86400,
        },
        decision: "push",
        reason: "test",
        timestamp: now - i * 86400,
      });
    }

    const engine = new PatternEngine(ctx, log, 14);
    const patterns = await engine.compute();
    expect(patterns.batteryPatterns).toBeDefined();
    expect(patterns.batteryPatterns.lowBatteryFrequency).toBeGreaterThan(0);
  });

  it("computes event stats with top sources", async () => {
    const now = Date.now() / 1000;
    const sources = ["device.battery", "device.battery", "health.summary", "geofence.triggered"];
    for (let i = 0; i < sources.length; i++) {
      await log.append({
        event: {
          subscriptionId: "test",
          source: sources[i],
          data: {},
          firedAt: now - i * 3600,
        },
        decision: i % 2 === 0 ? "push" : "drop",
        reason: "test",
        timestamp: now - i * 3600,
      });
    }

    const engine = new PatternEngine(ctx, log, 14);
    const patterns = await engine.compute();
    expect(patterns.eventStats.topSources).toContain("device.battery");
    expect(patterns.eventStats.eventsPerDay7d).toBeGreaterThan(0);
  });

  it("returns empty patterns when no events", async () => {
    const engine = new PatternEngine(ctx, log, 14);
    const patterns = await engine.compute();
    expect(patterns.healthTrends.stepsAvg7d).toBeNull();
    expect(patterns.locationRoutines.weekday).toHaveLength(0);
    expect(patterns.locationRoutines.weekend).toHaveLength(0);
    expect(patterns.eventStats.eventsPerDay7d).toBe(0);
    expect(patterns.eventStats.topSources).toHaveLength(0);
  });

  it("triggers events.rotate() after computing", async () => {
    const engine = new PatternEngine(ctx, log, 14);
    const rotateSpy = vi.spyOn(log, "rotate");

    await engine.compute();

    expect(rotateSpy).toHaveBeenCalledOnce();
    rotateSpy.mockRestore();
  });

  it("writes patterns to context", async () => {
    const engine = new PatternEngine(ctx, log, 14);
    const writeSpy = vi.spyOn(ctx, "writePatterns");

    await engine.compute();

    expect(writeSpy).toHaveBeenCalledOnce();
    const written = writeSpy.mock.calls[0][0];
    expect(written.computedAt).toBeGreaterThan(0);
    writeSpy.mockRestore();
  });
});

describe("emptyPatterns", () => {
  it("returns correct shape with null/zero/empty defaults", () => {
    const p = emptyPatterns();
    expect(p.locationRoutines).toEqual({ weekday: [], weekend: [] });
    expect(p.healthTrends.stepsAvg7d).toBeNull();
    expect(p.healthTrends.stepsAvg30d).toBeNull();
    expect(p.healthTrends.stepsTrend).toBeNull();
    expect(p.healthTrends.sleepAvg7d).toBeNull();
    expect(p.healthTrends.sleepTrend).toBeNull();
    expect(p.healthTrends.restingHrAvg7d).toBeNull();
    expect(p.healthTrends.restingHrTrend).toBeNull();
    expect(p.batteryPatterns.avgDrainPerHour).toBeNull();
    expect(p.batteryPatterns.typicalChargeTime).toBeNull();
    expect(p.batteryPatterns.lowBatteryFrequency).toBeNull();
    expect(p.eventStats.eventsPerDay7d).toBe(0);
    expect(p.eventStats.pushesPerDay7d).toBe(0);
    expect(p.eventStats.dropRate7d).toBe(0);
    expect(p.eventStats.topSources).toEqual([]);
    expect(p.computedAt).toBe(0);
  });
});

describe("PatternEngine.startSchedule/stopSchedule", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls compute on startup", async () => {
    const tmpDir = await makeTmpDir("betterclaw-sched-");
    const ctx = new ContextManager(tmpDir);
    const log = new EventLog(tmpDir);
    const engine = new PatternEngine(ctx, log, 14);

    const computeSpy = vi.spyOn(engine, "compute").mockResolvedValue(emptyPatterns());

    engine.startSchedule(3);
    // compute is called via void promise on startup
    await vi.waitFor(() => expect(computeSpy).toHaveBeenCalledOnce());

    engine.stopSchedule();
    computeSpy.mockRestore();
  });

  it("stopSchedule prevents further compute calls", async () => {
    vi.useFakeTimers();
    const tmpDir = await makeTmpDir("betterclaw-sched-stop-");
    const ctx = new ContextManager(tmpDir);
    const log = new EventLog(tmpDir);
    const engine = new PatternEngine(ctx, log, 14);

    const computeSpy = vi.spyOn(engine, "compute").mockResolvedValue(emptyPatterns());

    engine.startSchedule(3);
    // Wait for initial compute
    await vi.advanceTimersByTimeAsync(0);
    const callCount = computeSpy.mock.calls.length;

    engine.stopSchedule();

    // Advance 48 hours - should not trigger more computes
    await vi.advanceTimersByTimeAsync(48 * 60 * 60 * 1000);
    expect(computeSpy.mock.calls.length).toBe(callCount);

    computeSpy.mockRestore();
  });

  it("daily callback is invoked on schedule", async () => {
    vi.useFakeTimers();
    const tmpDir = await makeTmpDir("betterclaw-sched-daily-");
    const ctx = new ContextManager(tmpDir);
    const log = new EventLog(tmpDir);
    const engine = new PatternEngine(ctx, log, 14);

    const computeSpy = vi.spyOn(engine, "compute").mockResolvedValue(emptyPatterns());
    const dailyCallback = vi.fn().mockResolvedValue(undefined);

    engine.startSchedule(3, dailyCallback);
    // Flush the initial (startup) compute
    await vi.advanceTimersByTimeAsync(0);

    // Advance time to cross the scheduled hour
    await vi.advanceTimersByTimeAsync(25 * 60 * 60 * 1000);

    expect(dailyCallback).toHaveBeenCalled();

    engine.stopSchedule();
    computeSpy.mockRestore();
  });
});
