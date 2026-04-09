import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { processEvent } from "../src/pipeline.js";
import type { PipelineDeps } from "../src/pipeline.js";
import type { RunLearnerDeps } from "../src/learner.js";
import type { ScanDeps } from "../src/reaction-scanner.js";
import { ContextManager } from "../src/context.js";
import { EventLog } from "../src/events.js";
import { RulesEngine } from "../src/filter.js";
import { ReactionTracker } from "../src/reactions.js";
import { makeTmpDir, mockLogger } from "./helpers.js";
import type { DeviceEvent, PluginConfig } from "../src/types.js";

// Mock triage + learner + jwt for pipeline error tests
vi.mock("../src/triage.js", () => ({
  triageEvent: vi.fn(async () => ({ push: true, reason: "mocked triage" })),
}));
vi.mock("../src/learner.js", () => ({
  loadTriageProfile: vi.fn(async () => null),
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
  calibrationDays: 3,
};

function makeBatteryCriticalEvent(): DeviceEvent {
  return {
    subscriptionId: "default.battery-critical",
    source: "device.battery",
    data: { level: 0.05 },
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
        waitForRun: vi.fn(async () => {}),
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

  return {
    api: makeMockApi(apiOverrides),
    config: baseConfig,
    context,
    events,
    rules,
    reactions,
    stateDir: tmpDir,
  };
}

// ---------- pipeline error paths ----------

describe("pipeline error paths", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir("error-pipeline-");
    vi.clearAllMocks();
  });

  it("pushToAgent failure logs event as drop", async () => {
    const deps = await makeDeps(tmpDir, { runRejects: true });
    // Set tier=premium, smartMode=true so pipeline reaches pushToAgent
    deps.context.setRuntimeState({ tier: "premium", smartMode: true });

    const event = makeBatteryCriticalEvent();
    await processEvent(deps, event);

    // Read event log — last entry should be "drop" with reason containing "push failed"
    const entries = await deps.events.readSince(0);
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const last = entries[entries.length - 1];
    expect(last.decision).toBe("drop");
    expect(last.reason).toContain("push failed");
  });

  it("context.save failure does not throw and event is still logged", async () => {
    const deps = await makeDeps(tmpDir);
    // Set tier=free, smartMode=false — free path stores event then returns
    deps.context.setRuntimeState({ tier: "free", smartMode: false });

    // Sabotage context.save to return false
    vi.spyOn(deps.context, "save").mockResolvedValue(false);

    const event = makeBatteryCriticalEvent();
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

    const event = makeBatteryCriticalEvent();
    // Should not throw
    await expect(processEvent(deps, event)).resolves.toBeUndefined();
  });
});

// ---------- learner error paths ----------

describe("learner error paths", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir("error-learner-");
    vi.clearAllMocks();
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
          waitForRun: vi.fn(async () => {}),
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

    const deps: RunLearnerDeps = {
      stateDir: tmpDir,
      workspaceDir: tmpDir,
      context,
      events,
      reactions,
      api,
    };

    // runLearner should not throw — the error is caught inside the try/finally
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
          waitForRun: vi.fn(async () => {}),
          getSessionMessages: vi.fn(async () => ({
            messages: [
              { role: "assistant", content: JSON.stringify({ summary: "test user", interruptionTolerance: "normal" }) },
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

    // Sabotage reactions.save
    vi.spyOn(reactions, "save").mockResolvedValue(false);

    const deps: RunLearnerDeps = {
      stateDir: tmpDir,
      workspaceDir: tmpDir,
      context,
      events,
      reactions,
      api,
    };

    // Should complete without throwing
    await expect(runLearner(deps)).resolves.toBeUndefined();
  });
});

// ---------- saveTriageProfile disk error ----------

describe("saveTriageProfile disk error", () => {
  it("returns false and logs error when write fails", async () => {
    const { saveTriageProfile } = await vi.importActual<typeof import("../src/learner.js")>("../src/learner.js");
    const logger = mockLogger();

    const result = await saveTriageProfile(
      "/dev/null/nonexistent/deeply/nested",
      { summary: "test", interruptionTolerance: "normal", computedAt: Date.now() / 1000 },
      logger,
    );

    expect(result).toBe(false);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][0]).toContain("triage profile save failed");
  });
});

// ---------- scanPendingReactions API failure ----------

describe("scanPendingReactions API failure", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir("error-scanner-");
    vi.clearAllMocks();
  });

  it("returns gracefully when getSessionMessages throws", async () => {
    const { scanPendingReactions } = await vi.importActual<typeof import("../src/reaction-scanner.js")>("../src/reaction-scanner.js");

    const reactions = new ReactionTracker(tmpDir);
    // Seed a pending reaction with BetterClaw marker in messageSummary
    reactions.recordPush({
      subscriptionId: "default.battery-low",
      source: "device.battery",
      pushedAt: Date.now() / 1000,
      messageSummary: "[BetterClaw device event — processed by context plugin] battery low",
    });

    const api = {
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      runtime: {
        subagent: {
          getSessionMessages: vi.fn(async () => { throw new Error("API unavailable"); }),
          run: vi.fn(async () => ({ runId: "mock" })),
          deleteSession: vi.fn(async () => {}),
          waitForRun: vi.fn(async () => {}),
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
