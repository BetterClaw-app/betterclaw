import { describe, it, expect, vi, beforeEach } from "vitest";
import { processEvent } from "../../src/pipeline.js";
import { makeTmpDir } from "../helpers.js";
import type { PipelineDeps } from "../../src/pipeline.js";
import { ContextManager } from "../../src/context.js";
import { EventLog } from "../../src/events.js";
import { RulesEngine } from "../../src/filter.js";
import { ReactionTracker } from "../../src/reactions.js";
import { AuditLog } from "../../src/routing/audit-log.js";
import { RoutingConfigStore } from "../../src/routing/config-store.js";
import type { DeviceEvent, PluginConfig } from "../../src/types.js";
import { triageEvent } from "../../src/triage.js";
import { requireEntitlement } from "../../src/jwt.js";

vi.mock("../../src/jwt.js", () => ({
  requireEntitlement: vi.fn(() => null),
}));

vi.mock("../../src/triage.js", () => ({
  triageEvent: vi.fn(async () => ({ action: "drop", reason: "mocked triage" })),
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

function makeEvent(overrides?: Partial<DeviceEvent>): DeviceEvent {
  return {
    subscriptionId: "default.daily-health",
    source: "health.summary",
    data: { stepsToday: 5000 },
    firedAt: Date.now() / 1000,
    ...overrides,
  };
}

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
  const audit = new AuditLog(tmpDir);
  const routing = await RoutingConfigStore.load(tmpDir, audit);

  return {
    api: mockApi,
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

describe("pipeline integration", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir("betterclaw-pipeline-");
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

  it("premium tier: critical battery event matches explicit rule (notify), reaction recorded as pending", async () => {
    const deps = await makeDeps(tmpDir);
    deps.context.setRuntimeState({ tier: "premium", smartMode: true });

    await processEvent(deps, makeBatteryCriticalEvent());

    // Event log should have a notify decision (battery-critical rule is explicit+notify)
    const entries = await deps.events.readRecent(10);
    expect(entries).toHaveLength(1);
    expect(entries[0].decision).toBe("notify");

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

  it("entitlement check failure: event blocked when requireEntitlement returns error", async () => {
    const deps = await makeDeps(tmpDir);
    deps.context.setRuntimeState({ tier: "premium", smartMode: true });
    (requireEntitlement as ReturnType<typeof vi.fn>).mockReturnValueOnce("no valid JWT");

    await processEvent(deps, makeEvent());

    const entries = await deps.events.readRecent(10);
    expect(entries).toHaveLength(1);
    expect(entries[0].decision).toBe("blocked");
    expect(entries[0].reason).toContain("no premium entitlement");
    expect(mockApi.runtime.subagent.run).not.toHaveBeenCalled();
  });

  it("triage returns drop: non-explicit-match event dropped after LLM says drop", async () => {
    const deps = await makeDeps(tmpDir);
    // Replace the shipped catch-all (explicit drop) with a non-explicit fallback
    // so triage gets invoked.
    await deps.routing.applyPatch(
      [{ op: "replace", path: "/rules", value: [{ id: "fallback", match: "*", action: "drop", explicit: false }] }],
      "default",
      "test setup",
    );
    deps.context.setRuntimeState({ tier: "premium", smartMode: true });
    vi.spyOn(deps.rules, "evaluate").mockReturnValue({ action: "ambiguous", reason: "no rule matched" });
    (triageEvent as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ action: "drop", reason: "low relevance" });

    await processEvent(deps, makeEvent());

    const entries = await deps.events.readRecent(10);
    expect(entries).toHaveLength(1);
    expect(entries[0].decision).toBe("drop");
    expect(entries[0].reason).toContain("low relevance");
    expect(mockApi.runtime.subagent.run).not.toHaveBeenCalled();
  });

  it("triage returns notify: non-explicit-match event notified after LLM says notify", async () => {
    // Pin the clock outside the default 23:00-07:00 quiet-hours window so
    // non-explicit notify isn't demoted to push.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-18T14:00:00Z"));
    try {
      const deps = await makeDeps(tmpDir);
      // Replace rules with a single non-explicit catch-all so triage is invoked.
      await deps.routing.applyPatch(
        [{ op: "replace", path: "/rules", value: [{ id: "fallback", match: "*", action: "drop", explicit: false }] }],
        "default",
        "test setup",
      );
      deps.context.setRuntimeState({ tier: "premium", smartMode: true });
      vi.spyOn(deps.rules, "evaluate").mockReturnValue({ action: "ambiguous", reason: "no rule matched" });
      (triageEvent as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ action: "notify", reason: "user cares about health" });

      await processEvent(deps, makeEvent());

      const entries = await deps.events.readRecent(10);
      expect(entries).toHaveLength(1);
      expect(entries[0].decision).toBe("notify");
      expect(entries[0].reason).toContain("user cares about health");
      expect(mockApi.runtime.subagent.run).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("free tier: health event stored without push or triage", async () => {
    const deps = await makeDeps(tmpDir);
    deps.context.setRuntimeState({ tier: "free", smartMode: false });
    const triageSpy = triageEvent as ReturnType<typeof vi.fn>;

    await processEvent(deps, makeEvent());

    const entries = await deps.events.readRecent(10);
    expect(entries).toHaveLength(1);
    expect(entries[0].decision).toBe("free_stored");
    expect(entries[0].reason).toContain("free tier");
    expect(triageSpy).not.toHaveBeenCalled();
    expect(mockApi.runtime.subagent.run).not.toHaveBeenCalled();
  });

  it("rules engine dedup: event dropped without calling triage", async () => {
    const deps = await makeDeps(tmpDir);
    deps.context.setRuntimeState({ tier: "premium", smartMode: true });
    vi.spyOn(deps.rules, "evaluate").mockReturnValue({ action: "drop", reason: "dedup: default.daily-health fired 300s ago (cooldown: 1800s)" });
    const triageSpy = triageEvent as ReturnType<typeof vi.fn>;

    await processEvent(deps, makeEvent());

    const entries = await deps.events.readRecent(10);
    expect(entries).toHaveLength(1);
    expect(entries[0].decision).toBe("drop");
    expect(entries[0].reason).toContain("dedup:");
    expect(triageSpy).not.toHaveBeenCalled();
    expect(mockApi.runtime.subagent.run).not.toHaveBeenCalled();
  });

  it("smartMode off with health event: stored without triage or push", async () => {
    const deps = await makeDeps(tmpDir);
    deps.context.setRuntimeState({ tier: "premium", smartMode: false });
    const triageSpy = triageEvent as ReturnType<typeof vi.fn>;

    await processEvent(deps, makeEvent());

    const entries = await deps.events.readRecent(10);
    expect(entries).toHaveLength(1);
    expect(entries[0].decision).toBe("stored");
    expect(entries[0].reason).toContain("smartMode off");
    expect(triageSpy).not.toHaveBeenCalled();
    expect(mockApi.runtime.subagent.run).not.toHaveBeenCalled();
  });
});
