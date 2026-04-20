import { describe, it, expect, vi, beforeEach } from "vitest";
import { processEvent } from "../src/pipeline.js";
import type { PipelineDeps } from "../src/pipeline.js";
import type { RunLearnerDeps } from "../src/learner.js";
import type { ScanDeps } from "../src/reaction-scanner.js";
import { ContextManager } from "../src/context.js";
import { EventLog } from "../src/events.js";
import { RulesEngine } from "../src/filter.js";
import { ReactionTracker } from "../src/reactions.js";
import { AuditLog } from "../src/routing/audit-log.js";
import { RoutingConfigStore } from "../src/routing/config-store.js";
import { makeTmpDir } from "./helpers.js";
import type { DeviceEvent, PluginConfig } from "../src/types.js";

// Note: diagnostic-logger.js is NOT mocked here — dlog defaults to a NOOP
// singleton (src/diagnostic-logger.ts:24), so unmocked usage is safe.

// Mock triage + jwt for pipeline error tests
vi.mock("../src/triage.js", () => ({
  triageEvent: vi.fn(async () => ({ action: "notify", reason: "mocked triage" })),
}));
vi.mock("../src/jwt.js", () => ({
  requireEntitlement: vi.fn(() => null),
}));

const baseConfig: PluginConfig = {
  triageModel: "openai/gpt-4o-mini",
  pushBudgetPerDay: 10,
  patternWindowDays: 7,
  proactiveEnabled: false,
  analysisHour: 7,
  deduplicationCooldowns: {},
  defaultCooldown: 1800,
};

function makeTestEvent(): DeviceEvent {
  return {
    subscriptionId: "sub.test-explicit",
    source: "test.explicit",
    data: {},
    firedAt: Date.now() / 1000,
  };
}

function makeMockApi(overrides?: { runRejects?: boolean }) {
  return {
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    runtime: {
      subagent: {
        run: overrides?.runRejects
          ? vi.fn(async () => { throw new Error("subagent unavailable"); })
          : vi.fn(async () => ({ runId: "mock-run-id" })),
        deleteSession: vi.fn(async () => {}),
        waitForRun: vi.fn(async () => ({ status: "completed" })),
        getSessionMessages: vi.fn(async () => ({ messages: [] })),
      },
      modelAuth: {
        resolveApiKeyForProvider: vi.fn(async () => ({ apiKey: "mock-key" })),
      },
    },
  } as unknown as PipelineDeps["api"];
}

async function makeDeps(tmpDir: string, apiOverrides?: { runRejects?: boolean }): Promise<PipelineDeps> {
  const context = new ContextManager(tmpDir);
  const events = new EventLog(tmpDir);
  const rules = new RulesEngine(baseConfig.pushBudgetPerDay, baseConfig.deduplicationCooldowns, baseConfig.defaultCooldown);
  const reactions = new ReactionTracker(tmpDir);
  const audit = new AuditLog(tmpDir);
  const routing = await RoutingConfigStore.load(tmpDir, audit);

  return {
    api: makeMockApi(apiOverrides),
    config: baseConfig,
    context,
    events,
    rules,
    reactions,
    stateDir: tmpDir,
    routing,
    audit,
  };
}

// ---------- pipeline error paths ----------

describe("pipeline error paths", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir("error-pipeline-");
  });

  it("pushToAgent failure logs event as drop", async () => {
    const deps = await makeDeps(tmpDir, { runRejects: true });
    // Set tier=premium, smartMode=true so pipeline reaches pushToAgent
    deps.context.setRuntimeState({ tier: "premium", smartMode: true });
    // Inject an explicit notify rule so the event reaches subagent.run
    await deps.routing.applyPatch(
      [{ op: "add", path: "/rules/0", value: {
        id: "test-explicit-notify",
        match: { source: "test.explicit" },
        action: "notify",
        explicit: true,
        respectQuietHours: false,
      } }],
      "default",
      "test fixture",
    );

    const event = makeTestEvent();
    await processEvent(deps, event);

    // Read event log — last entry should be "drop" with reason containing "dispatch failed"
    const entries = await deps.events.readSince(0);
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const last = entries[entries.length - 1];
    expect(last.decision).toBe("drop");
    expect(last.reason).toContain("dispatch failed");
  });

  it("context.save failure does not throw and event is still logged", async () => {
    const deps = await makeDeps(tmpDir);
    // Set tier=free, smartMode=false — free path stores event then returns
    deps.context.setRuntimeState({ tier: "free", smartMode: false });

    // Sabotage context.save to return false
    vi.spyOn(deps.context, "save").mockResolvedValue(false);

    const event = makeTestEvent();
    // Should not throw
    await processEvent(deps, event);

    // Event should still be logged
    const entries = await deps.events.readSince(0);
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0].decision).toBe("free_stored");
  });

  it("events.append failure does not cause unhandled rejection", async () => {
    const deps = await makeDeps(tmpDir);
    deps.context.setRuntimeState({ tier: "free", smartMode: false });

    // Sabotage events.append to return false
    vi.spyOn(deps.events, "append").mockResolvedValue(false);

    const event = makeTestEvent();
    // Should not throw
    await expect(processEvent(deps, event)).resolves.toBeUndefined();
  });
});

// ---------- learner error paths ----------

describe("learner error paths", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir("error-learner-");
  });

  it("deleteSession is called even when subagent.run throws", async () => {
    const { runLearner } = await vi.importActual<typeof import("../src/learner.js")>("../src/learner.js");

    const deleteSession = vi.fn(async () => {});
    const api = {
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      runtime: {
        subagent: {
          run: vi.fn(async () => { throw new Error("subagent crashed"); }),
          deleteSession,
          waitForRun: vi.fn(async () => ({ status: "completed" })),
          getSessionMessages: vi.fn(async () => ({ messages: [] })),
        },
        modelAuth: {
          resolveApiKeyForProvider: vi.fn(async () => ({ apiKey: "mock-key" })),
        },
      },
    } as unknown as RunLearnerDeps["api"];

    const context = new ContextManager(tmpDir);
    const events = new EventLog(tmpDir);
    const reactions = new ReactionTracker(tmpDir);
    const audit = new AuditLog(tmpDir);
    const routing = await RoutingConfigStore.load(tmpDir, audit);

    const deps: RunLearnerDeps = {
      stateDir: tmpDir,
      workspaceDir: tmpDir,
      context,
      events,
      reactions,
      api,
      routing,
      audit,
    };

    // runLearner uses try/finally (no catch) — error propagates but deleteSession still runs
    await expect(runLearner(deps)).rejects.toThrow("subagent crashed");

    // deleteSession should have been called at least twice (pre-cleanup + finally)
    expect(deleteSession).toHaveBeenCalledTimes(2);
  });

  it("reactions.save failure does not crash runLearner", async () => {
    const { runLearner } = await vi.importActual<typeof import("../src/learner.js")>("../src/learner.js");

    const api = {
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      runtime: {
        subagent: {
          run: vi.fn(async () => ({ runId: "mock-run-id" })),
          deleteSession: vi.fn(async () => {}),
          waitForRun: vi.fn(async () => ({ status: "completed" })),
          getSessionMessages: vi.fn(async () => ({
            messages: [
              { role: "assistant", content: JSON.stringify({ patchOps: [], reason: "no change" }) },
            ],
          })),
        },
        modelAuth: {
          resolveApiKeyForProvider: vi.fn(async () => ({ apiKey: "mock-key" })),
        },
      },
    } as unknown as RunLearnerDeps["api"];

    const context = new ContextManager(tmpDir);
    const events = new EventLog(tmpDir);
    const reactions = new ReactionTracker(tmpDir);
    const audit = new AuditLog(tmpDir);
    const routing = await RoutingConfigStore.load(tmpDir, audit);

    // Sabotage reactions.save
    vi.spyOn(reactions, "save").mockResolvedValue(false);

    const deps: RunLearnerDeps = {
      stateDir: tmpDir,
      workspaceDir: tmpDir,
      context,
      events,
      reactions,
      api,
      routing,
      audit,
    };

    // Should complete without throwing
    await expect(runLearner(deps)).resolves.toBeUndefined();
  });
});

// ---------- scanPendingReactions API failure ----------

describe("scanPendingReactions API failure", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir("error-scanner-");
  });

  it("returns gracefully when getSessionMessages throws", async () => {
    const { scanPendingReactions } = await vi.importActual<typeof import("../src/reaction-scanner.js")>("../src/reaction-scanner.js");

    const reactions = new ReactionTracker(tmpDir);
    // Seed a pending reaction with BetterClaw marker in messageSummary
    reactions.recordPush({
      subscriptionId: "default.daily-health",
      source: "health.daily",
      pushedAt: Date.now() / 1000,
      messageSummary: "[BetterClaw device event — processed by context plugin] health summary",
    });

    const api = {
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      runtime: {
        subagent: {
          getSessionMessages: vi.fn(async () => { throw new Error("API unavailable"); }),
          run: vi.fn(async () => ({ runId: "mock" })),
          deleteSession: vi.fn(async () => {}),
          waitForRun: vi.fn(async () => ({ status: "completed" })),
        },
      },
    } as unknown as ScanDeps["api"];

    const deps: ScanDeps = { api, reactions };

    // Should not throw
    await expect(scanPendingReactions(deps)).resolves.toBeUndefined();

    // Reaction should still be pending (not classified)
    const pending = reactions.getPending();
    expect(pending.length).toBe(1);
    expect(pending[0].status).toBe("pending");
  });
});
