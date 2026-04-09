import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { processEvent } from "../../src/pipeline.js";
import type { PipelineDeps } from "../../src/pipeline.js";
import { ContextManager } from "../../src/context.js";
import { EventLog } from "../../src/events.js";
import { RulesEngine } from "../../src/filter.js";
import { ReactionTracker } from "../../src/reactions.js";
import type { DeviceEvent, PluginConfig } from "../../src/types.js";

vi.mock("../../src/jwt.js", () => ({
  requireEntitlement: vi.fn(() => null),
}));

vi.mock("../../src/triage.js", () => ({
  triageEvent: vi.fn(async () => ({ push: false, reason: "mocked triage" })),
}));

vi.mock("../../src/learner.js", () => ({
  loadTriageProfile: vi.fn(async () => ({
    summary: "test",
    interruptionTolerance: "normal",
    computedAt: 0,
  })),
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

const mockApi = {
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
  runtime: {
    subagent: {
      run: vi.fn(async () => ({ runId: "mock-run-id" })),
    },
    modelAuth: {
      resolveApiKeyForProvider: vi.fn(async () => ({ apiKey: "mock-key" })),
    },
  },
} as unknown as PipelineDeps["api"];

function makeBatteryCriticalEvent(): DeviceEvent {
  return {
    subscriptionId: "default.battery-critical",
    source: "device.battery",
    data: { level: 0.05 },
    firedAt: Date.now() / 1000,
  };
}

async function makeDeps(tmpDir: string): Promise<PipelineDeps> {
  const context = new ContextManager(tmpDir);
  const events = new EventLog(tmpDir);
  const rules = new RulesEngine(baseConfig.pushBudgetPerDay, baseConfig.deduplicationCooldowns, baseConfig.defaultCooldown);
  const reactions = new ReactionTracker(tmpDir);

  return {
    api: mockApi,
    config: baseConfig,
    context,
    events,
    rules,
    reactions,
    stateDir: tmpDir,
  };
}

describe("pipeline integration", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-pipeline-"));
    vi.clearAllMocks();
  });

  it("free tier: stores event with free_stored decision, no push attempt", async () => {
    const deps = await makeDeps(tmpDir);
    deps.context.setRuntimeState({ tier: "free", smartMode: false });

    await processEvent(deps, makeBatteryCriticalEvent());

    const entries = await deps.events.readRecent(10);
    expect(entries).toHaveLength(1);
    expect(entries[0].decision).toBe("free_stored");
    expect(entries[0].reason).toContain("free tier");

    // No push to agent
    expect(mockApi.runtime.subagent.run).not.toHaveBeenCalled();
  });

  it("premium tier: critical battery event is pushed, reaction recorded as pending", async () => {
    const deps = await makeDeps(tmpDir);
    deps.context.setRuntimeState({ tier: "premium", smartMode: true });

    await processEvent(deps, makeBatteryCriticalEvent());

    // Event log should have a push decision
    const entries = await deps.events.readRecent(10);
    expect(entries).toHaveLength(1);
    expect(entries[0].decision).toBe("push");

    // Agent should have been called
    expect(mockApi.runtime.subagent.run).toHaveBeenCalledOnce();

    // Reaction recorded as pending
    const reactions = deps.reactions.getRecent();
    expect(reactions).toHaveLength(1);
    expect(reactions[0].subscriptionId).toBe("default.battery-critical");
    expect(reactions[0].status).toBe("pending");
  });

  it("smartMode off: event stored with stored decision, no push attempt", async () => {
    const deps = await makeDeps(tmpDir);
    deps.context.setRuntimeState({ tier: "premium", smartMode: false });

    await processEvent(deps, makeBatteryCriticalEvent());

    const entries = await deps.events.readRecent(10);
    expect(entries).toHaveLength(1);
    expect(entries[0].decision).toBe("stored");
    expect(entries[0].reason).toContain("smartMode off");

    expect(mockApi.runtime.subagent.run).not.toHaveBeenCalled();
  });
});
