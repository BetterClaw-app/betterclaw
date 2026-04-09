import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { processEvent, type PipelineDeps } from "../../src/pipeline.js";
import { ContextManager } from "../../src/context.js";
import { EventLog } from "../../src/events.js";
import { RulesEngine } from "../../src/filter.js";
import { ReactionTracker } from "../../src/reactions.js";
import { PatternEngine } from "../../src/patterns.js";
import { runLearner } from "../../src/learner.js";
import { scanPendingReactions } from "../../src/reaction-scanner.js";
import type { DeviceEvent, PluginConfig } from "../../src/types.js";
import { makeTmpDir } from "../helpers.js";

// --- Module-level mocks (boundaries only) ---

vi.mock("../../src/jwt.js", () => ({
  storeJwt: vi.fn(async () => ({ sub: "test", aud: "betterclaw", ent: ["premium"], iat: 0, exp: 9999999999, iss: "api.betterclaw.app" })),
  requireEntitlement: vi.fn(() => null),
  getVerifiedPayload: vi.fn(() => ({ sub: "test", aud: "betterclaw", ent: ["premium"], iat: 0, exp: 9999999999, iss: "api.betterclaw.app" })),
  hasEntitlement: vi.fn(() => true),
  _resetJwtState: vi.fn(),
  _setPayloadForTesting: vi.fn(),
}));

vi.mock("../../src/diagnostic-logger.js", () => ({
  dlog: { debug() {}, info() {}, warn() {}, error() {} },
  initDiagnosticLogger: vi.fn(),
}));

// Mock fetch globally for triage calls
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// --- Shared config & helpers ---

const baseConfig: PluginConfig = {
  triageModel: "openai/gpt-4o-mini",
  pushBudgetPerDay: 3, // low for budget tests
  patternWindowDays: 7,
  proactiveEnabled: false,
  analysisHour: 7,
  deduplicationCooldowns: {},
  defaultCooldown: 1800,
  calibrationDays: 3,
};

function makeMockApi() {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    runtime: {
      subagent: {
        run: vi.fn(async () => ({ runId: "mock-run-id" })),
        waitForRun: vi.fn(async () => ({ status: "completed" })),
        getSessionMessages: vi.fn(async () => ({ messages: [] })),
        deleteSession: vi.fn(async () => {}),
      },
      modelAuth: {
        resolveApiKeyForProvider: vi.fn(async () => ({ apiKey: "mock-key" })),
      },
    },
  } as unknown as PipelineDeps["api"];
}

function makeDeps(tmpDir: string, configOverrides?: Partial<PluginConfig>) {
  const config = { ...baseConfig, ...configOverrides };
  const context = new ContextManager(tmpDir);
  const events = new EventLog(tmpDir);
  const rules = new RulesEngine(config.pushBudgetPerDay, config.deduplicationCooldowns, config.defaultCooldown);
  const reactions = new ReactionTracker(tmpDir);
  const patterns = new PatternEngine(context, events, config.patternWindowDays);
  const api = makeMockApi();

  context.setRuntimeState({ tier: "premium", smartMode: true });

  return {
    deps: { api, config, context, events, rules, reactions, stateDir: tmpDir } satisfies PipelineDeps,
    patterns,
  };
}

function batteryLowEvent(level: number, firedAt?: number): DeviceEvent {
  return {
    subscriptionId: "default.battery-low",
    source: "device.battery",
    data: { level },
    firedAt: firedAt ?? Date.now() / 1000,
  };
}

function batteryCriticalEvent(level: number, firedAt?: number): DeviceEvent {
  return {
    subscriptionId: "default.battery-critical",
    source: "device.battery",
    data: { level: level },
    firedAt: firedAt ?? Date.now() / 1000,
  };
}

function geofenceEvent(zoneName: string, type: number, firedAt?: number): DeviceEvent {
  return {
    subscriptionId: `geofence.${zoneName.toLowerCase()}`,
    source: "geofence.triggered",
    data: { type, latitude: 48.1, longitude: 11.5 },
    metadata: { zoneName },
    firedAt: firedAt ?? Date.now() / 1000,
  };
}

function healthEvent(steps: number, firedAt?: number): DeviceEvent {
  return {
    subscriptionId: "default.daily-health",
    source: "health.summary",
    data: { stepsToday: steps },
    firedAt: firedAt ?? Date.now() / 1000,
  };
}

function customEvent(source: string, data: Record<string, number>, firedAt?: number): DeviceEvent {
  return {
    subscriptionId: `custom.${source}`,
    source,
    data,
    firedAt: firedAt ?? Date.now() / 1000,
  };
}

function triageFetchResponse(push: boolean, reason: string = "test reason") {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ push, reason, priority: "normal" }) } }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

// --- Tests ---

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await makeTmpDir("betterclaw-e2e-");
  tmpDirs.push(tmpDir);
  // Re-stub fetch (unstubGlobals restores the original after each test)
  vi.stubGlobal("fetch", mockFetch);
  // Default: triage returns push:true
  mockFetch.mockResolvedValue(triageFetchResponse(true, "relevant event"));
});

const tmpDirs: string[] = [];

afterAll(async () => {
  // Cleanup all tmpDirs (best-effort)
  for (const dir of tmpDirs) {
    try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe("Scenario 1: Full event lifecycle", () => {
  it("processes battery-low event through the full pipeline", async () => {
    const { deps, patterns } = makeDeps(tmpDir);
    const event = batteryLowEvent(0.15);

    await processEvent(deps, event);

    // Context updated with battery level
    const ctx = deps.context.get();
    expect(ctx.device.battery).not.toBeNull();
    expect(ctx.device.battery!.level).toBe(0.15);

    // Event logged with push decision (battery-low always pushes when level changed)
    const entries = await deps.events.readAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].decision).toBe("push");

    // subagent.run called with message containing marker and battery percentage
    const runCall = (deps.api.runtime.subagent.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(runCall.message).toContain("[BetterClaw device event");
    expect(runCall.message).toContain("15%");

    // Patterns computable from the event
    const computed = await patterns.compute();
    expect(computed).toBeDefined();
    expect(computed.computedAt).toBeGreaterThan(0);
  });
});

describe("Scenario 2: Learner cycle", () => {
  it("runs learner with seeded events and reactions", async () => {
    const { deps } = makeDeps(tmpDir);
    const now = Date.now() / 1000;

    // Seed 5 events
    for (let i = 0; i < 5; i++) {
      await deps.events.append({
        event: healthEvent(5000 + i * 1000, now - 3600 + i * 60),
        decision: "push",
        reason: "test push",
        timestamp: now - 3600 + i * 60,
      });
    }

    // Seed 3 reactions
    for (let i = 0; i < 3; i++) {
      deps.reactions.recordPush({
        subscriptionId: `default.daily-health`,
        source: "health.summary",
        pushedAt: now - 3600 + i * 60,
        messageSummary: `[BetterClaw device event] Health event #${i}`,
      });
    }
    await deps.reactions.save();

    // Mock subagent to return valid triage profile JSON
    const api = deps.api as any;
    api.runtime.subagent.getSessionMessages.mockResolvedValue({
      messages: [
        { role: "assistant", content: JSON.stringify({ summary: "User cares about health metrics", interruptionTolerance: "normal", computedAt: now }) },
      ],
    });

    await runLearner({
      stateDir: tmpDir,
      workspaceDir: tmpDir,
      context: deps.context,
      events: deps.events,
      reactions: deps.reactions,
      api: deps.api,
    });

    // subagent.run called (for the learner session)
    expect(api.runtime.subagent.run).toHaveBeenCalled();

    // Prompt should contain subscription IDs from seeded events
    const runCall = api.runtime.subagent.run.mock.calls[0][0];
    expect(runCall.message).toContain("default.daily-health");

    // Profile saved to disk
    const profilePath = path.join(tmpDir, "triage-profile.json");
    const profileContent = await fs.readFile(profilePath, "utf-8");
    const profile = JSON.parse(profileContent);
    expect(profile.summary).toContain("health");
    expect(profile.interruptionTolerance).toBe("normal");

    // Reactions file still exists (rotate keeps recent)
    const reactionsPath = path.join(tmpDir, "push-reactions.jsonl");
    const reactionsContent = await fs.readFile(reactionsPath, "utf-8");
    expect(reactionsContent.length).toBeGreaterThan(0);
  });
});

describe("Scenario 3: Reaction scan cycle", () => {
  it("classifies 3 pending reactions using transcript search", async () => {
    const { deps } = makeDeps(tmpDir);
    const now = Date.now() / 1000;

    // Seed 3 pending reactions with BetterClaw marker
    // messageSummary must match the first 30 chars of the transcript message (findPushInMessages checks this)
    const messagePrefixes = [
      "[BetterClaw device event — processed by context plugin]\n\nBattery at 20%",
      "[BetterClaw device event — processed by context plugin]\n\nBattery at 21%",
      "[BetterClaw device event — processed by context plugin]\n\nBattery at 22%",
    ];
    for (let i = 0; i < 3; i++) {
      deps.reactions.recordPush({
        subscriptionId: `reaction-${i}`,
        source: "device.battery",
        pushedAt: now - 300 + i * 10,
        messageSummary: messagePrefixes[i].slice(0, 100),
      });
    }
    await deps.reactions.save();

    const api = deps.api as any;

    // Mock getSessionMessages with dual session key handling:
    // - "main" → returns transcript with BetterClaw markers + subsequent messages
    // - classification sessions → returns classification JSON
    api.runtime.subagent.getSessionMessages.mockImplementation(async (opts: { sessionKey: string }) => {
      if (opts.sessionKey === "main") {
        const messages: Array<{ role: string; content: string; timestamp: number }> = [];
        for (let i = 0; i < 3; i++) {
          messages.push({
            role: "user",
            content: messagePrefixes[i] + "\n\nCurrent context: No context available.",
            timestamp: now - 300 + i * 10,
          });
          messages.push({
            role: "assistant",
            content: `I see the battery is at ${20 + i}%. Let me help with that.`,
            timestamp: now - 295 + i * 10,
          });
        }
        return { messages };
      }
      // Classification sessions return engagement result
      return {
        messages: [
          { role: "assistant", content: JSON.stringify({ status: "engaged", reason: "user acknowledged the notification" }) },
        ],
      };
    });

    await scanPendingReactions({ api: deps.api, reactions: deps.reactions });

    // All 3 should be classified (none pending)
    const pending = deps.reactions.getPending();
    expect(pending).toHaveLength(0);

    // Reactions saved to disk
    const reactionsPath = path.join(tmpDir, "push-reactions.jsonl");
    const content = await fs.readFile(reactionsPath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      const entry = JSON.parse(line);
      expect(entry.status).toBe("engaged");
    }
  });
});

describe("Scenario 4: State accumulation", () => {
  it("accumulates state from 10 mixed events", async () => {
    // Use defaultCooldown:0 to avoid dedup
    const { deps } = makeDeps(tmpDir, { defaultCooldown: 0 });
    const now = Date.now() / 1000;

    const events: DeviceEvent[] = [
      batteryLowEvent(0.45, now - 900),
      geofenceEvent("Home", 1, now - 800),
      healthEvent(3000, now - 700),
      customEvent("app.foreground", { screen: 1 }, now - 600),
      batteryLowEvent(0.35, now - 500),
      geofenceEvent("Home", 2, now - 400), // exit
      geofenceEvent("Office", 1, now - 300), // enter
      healthEvent(8000, now - 200),
      customEvent("app.background", { duration: 120 }, now - 100),
      batteryLowEvent(0.22, now - 50),
    ];

    for (const event of events) {
      await processEvent(deps, event);
    }

    // Context reflects latest values
    const ctx = deps.context.get();
    expect(ctx.device.battery!.level).toBe(0.22);
    expect(ctx.activity.currentZone).toBe("Office");
    expect(ctx.device.health!.stepsToday).toBe(8000);

    // All 10 events logged in order
    const entries = await deps.events.readAll();
    expect(entries).toHaveLength(10);

    // Patterns reflect accumulated data
    const patterns = new PatternEngine(deps.context, deps.events, 7);
    const computed = await patterns.compute();
    expect(computed.eventStats.topSources.length).toBeGreaterThan(0);
  });
});

describe("Scenario 5: Cold start", () => {
  it("processes first event from fresh state with no files", async () => {
    const freshDir = await makeTmpDir("betterclaw-e2e-cold-");
    tmpDirs.push(freshDir);
    const { deps, patterns } = makeDeps(freshDir);

    const event = batteryLowEvent(0.18);
    await processEvent(deps, event);

    // State files created
    const eventsPath = path.join(freshDir, "events.jsonl");
    const contextPath = path.join(freshDir, "context.json");
    await expect(fs.access(eventsPath)).resolves.toBeUndefined();
    await expect(fs.access(contextPath)).resolves.toBeUndefined();

    // Event logged
    const entries = await deps.events.readAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].decision).toBe("push");

    // Patterns computable from single event
    const computed = await patterns.compute();
    expect(computed).toBeDefined();
    expect(computed.batteryPatterns.lowBatteryFrequency).not.toBeNull();

    // Cleanup handled by afterAll
  });
});

describe("Scenario 6: Budget exhaustion + midnight reset", () => {
  it("exhausts budget, resets at midnight, then succeeds again", async () => {
    const { deps } = makeDeps(tmpDir, { defaultCooldown: 0 });
    const now = Date.now() / 1000;

    // Fill budget with 3 geofence events (unique zones to avoid dedup)
    // Geofence events always push AND bypass budget, but DO increment pushesToday
    await processEvent(deps, geofenceEvent("ZoneA", 1, now - 30));
    await processEvent(deps, geofenceEvent("ZoneB", 1, now - 20));
    await processEvent(deps, geofenceEvent("ZoneC", 1, now - 10));

    // Verify budget is now full
    expect(deps.context.get().meta.pushesToday).toBe(3);

    // Custom event should be dropped with "budget" reason (goes through ambiguous path, budget checked first)
    await processEvent(deps, customEvent("app.test", { value: 1 }, now));

    const entries = await deps.events.readAll();
    const lastEntry = entries[entries.length - 1];
    expect(lastEntry.decision).toBe("drop");
    expect(lastEntry.reason).toContain("budget");

    // Advance Date.now past midnight
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 1, 0, 0); // 00:01 next day
    const tomorrowEpochMs = tomorrow.getTime();
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(tomorrowEpochMs);

    // Process new event — the firedAt must also be in the new day to trigger daily counter reset
    const tomorrowEpochSec = tomorrowEpochMs / 1000;
    await processEvent(deps, geofenceEvent("ZoneD", 1, tomorrowEpochSec));

    // pushesToday should be reset (1 after the new push)
    expect(deps.context.get().meta.pushesToday).toBe(1);

    // Custom event should now succeed (budget has room)
    await processEvent(deps, customEvent("app.test2", { value: 2 }, tomorrowEpochSec + 1));

    const allEntries = await deps.events.readAll();
    const finalEntry = allEntries[allEntries.length - 1];
    expect(finalEntry.decision).toBe("push");
    expect(finalEntry.reason).toContain("triage");

    dateNowSpy.mockRestore();
  });

  it("battery-critical bypasses budget even when exhausted", async () => {
    const { deps } = makeDeps(tmpDir, { defaultCooldown: 0 });
    const now = Date.now() / 1000;

    // Fill budget with 3 geofence events
    await processEvent(deps, geofenceEvent("ZoneX", 1, now - 30));
    await processEvent(deps, geofenceEvent("ZoneY", 1, now - 20));
    await processEvent(deps, geofenceEvent("ZoneZ", 1, now - 10));

    expect(deps.context.get().meta.pushesToday).toBe(3);

    // Battery-critical should bypass budget
    await processEvent(deps, batteryCriticalEvent(0.05, now));

    const entries = await deps.events.readAll();
    const criticalEntry = entries[entries.length - 1];
    expect(criticalEntry.decision).toBe("push");
    expect(criticalEntry.reason).toContain("critical battery");

    // Push count incremented to 4 (over budget, but critical bypasses)
    expect(deps.context.get().meta.pushesToday).toBe(4);
  });
});
