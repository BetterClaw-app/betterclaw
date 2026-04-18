import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  readMemorySummary,
  runLearner,
  buildLearnerPrompt,
  parseLearnerOutput,
} from "../../src/learner.js";
import type { RunLearnerDeps, LearnerInput } from "../../src/learner.js";
import { AuditLog } from "../../src/routing/audit-log.js";
import { RoutingConfigStore } from "../../src/routing/config-store.js";
import type { RoutingRules, JsonPatchOp } from "../../src/routing/types.js";
import { makeTmpDir } from "../helpers.js";

vi.mock("../../src/diagnostic-logger.js", () => ({
  dlog: { info: vi.fn(), warn: vi.fn(), warning: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function makeSubagentApi(responseContent: string) {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    runtime: {
      subagent: {
        run: vi.fn(async () => ({ runId: "run-1" })),
        waitForRun: vi.fn(async () => ({ status: "completed" })),
        getSessionMessages: vi.fn(async () => ({
          messages: [
            { role: "user", content: "prompt" },
            { role: "assistant", content: responseContent },
          ],
        })),
        deleteSession: vi.fn(async () => {}),
      },
    },
  } as unknown as RunLearnerDeps["api"];
}

async function makeRoutingDeps(stateDir: string) {
  const audit = new AuditLog(stateDir);
  const routing = await RoutingConfigStore.load(stateDir, audit);
  return { audit, routing };
}

function makeDeps(
  stateDir: string,
  workspaceDir: string,
  api: RunLearnerDeps["api"],
  routing: RoutingConfigStore,
  audit: AuditLog,
): RunLearnerDeps {
  return {
    stateDir,
    workspaceDir,
    context: {
      readPatterns: vi.fn(async () => ({})),
    } as unknown as RunLearnerDeps["context"],
    events: {
      readSince: vi.fn(async () => []),
    } as unknown as RunLearnerDeps["events"],
    reactions: {
      getRecent: vi.fn(() => []),
      rotate: vi.fn(),
      save: vi.fn(async () => true),
    } as unknown as RunLearnerDeps["reactions"],
    api,
    routing,
    audit,
  };
}

const MINIMAL_RULES: RoutingRules = {
  version: 1,
  quietHours: { start: "22:00", end: "07:00", tz: "auto" },
  rules: [
    { id: "r1", match: { source: "device.battery" }, action: "notify", explicit: false },
  ],
};

// ----- parseLearnerOutput -----

describe("parseLearnerOutput", () => {
  it("parses well-formed JSON with patchOps + reason", () => {
    const raw = JSON.stringify({
      patchOps: [{ op: "replace", path: "/rules/0/action", value: "push" }],
      reason: "user ignores battery notifies",
    });
    const out = parseLearnerOutput(raw);
    expect(out.patchOps).toHaveLength(1);
    expect(out.patchOps[0].op).toBe("replace");
    expect(out.reason).toBe("user ignores battery notifies");
  });

  it("strips markdown code fences", () => {
    const raw = "```json\n" + JSON.stringify({ patchOps: [], reason: "no change" }) + "\n```";
    const out = parseLearnerOutput(raw);
    expect(out.patchOps).toEqual([]);
    expect(out.reason).toBe("no change");
  });

  it("returns empty patchOps + failure reason for invalid JSON", () => {
    const out = parseLearnerOutput("this is definitely not JSON");
    expect(out.patchOps).toEqual([]);
    expect(out.reason).toBe("failed to parse learner output");
  });

  it("treats missing patchOps as empty array", () => {
    const out = parseLearnerOutput(JSON.stringify({ reason: "nothing to change" }));
    expect(out.patchOps).toEqual([]);
    expect(out.reason).toBe("nothing to change");
  });

  it("defaults reason when missing", () => {
    const out = parseLearnerOutput(JSON.stringify({ patchOps: [] }));
    expect(out.reason).toBe("no reason");
  });

  it("ignores non-array patchOps", () => {
    const out = parseLearnerOutput(JSON.stringify({ patchOps: "nope", reason: "bad" }));
    expect(out.patchOps).toEqual([]);
    expect(out.reason).toBe("bad");
  });
});

// ----- buildLearnerPrompt -----

describe("buildLearnerPrompt", () => {
  const baseInput: LearnerInput = {
    memorySummary: null,
    recentEvents: [],
    reactions: [],
    patternsJson: "{}",
    currentRules: MINIMAL_RULES,
    recentAudit: [],
    lockedKeys: new Set(),
  };

  it("renders the current rules as formatted JSON", () => {
    const prompt = buildLearnerPrompt(baseInput);
    expect(prompt).toContain("## Current Routing Rules");
    expect(prompt).toContain("\"version\": 1");
    expect(prompt).toContain("device.battery");
  });

  it("renders empty sections gracefully", () => {
    const prompt = buildLearnerPrompt(baseInput);
    expect(prompt).toContain("No memory summary available for today.");
    expect(prompt).toContain("No events in the last 24 hours.");
    expect(prompt).toContain("No reaction data available yet.");
    expect(prompt).toContain("No recent changes.");
    expect(prompt).toContain("## Locked Keys\nNone.");
  });

  it("lists locked keys when present", () => {
    const prompt = buildLearnerPrompt({
      ...baseInput,
      lockedKeys: new Set(["/quietHours/start", "/rules/0/action"]),
    });
    expect(prompt).toContain("## Locked Keys");
    expect(prompt).toContain("DO NOT modify them");
    expect(prompt).toContain("/quietHours/start");
    expect(prompt).toContain("/rules/0/action");
  });

  it("includes audit entries when present", () => {
    const prompt = buildLearnerPrompt({
      ...baseInput,
      recentAudit: [
        {
          ts: 1700000000,
          source: "user",
          docChecksum: "abc",
          diffs: [{ path: "/rules/0/action", from: "notify", to: "push" }],
          expiresAt: 1701000000,
        },
      ],
    });
    expect(prompt).toContain("## Recent Audit (last 30 days)");
    expect(prompt).toContain("source=user");
    expect(prompt).toContain("/rules/0/action");
  });

  it("asks for RFC 6902 patch ops", () => {
    const prompt = buildLearnerPrompt(baseInput);
    expect(prompt).toContain("JSON Patch");
    expect(prompt).toContain("patchOps");
    expect(prompt).toContain("reason");
  });
});

// ----- readMemorySummary (unchanged) -----

describe("readMemorySummary", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir("learner-mem-");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("reads memory file for given date", async () => {
    const memDir = path.join(tmpDir, "memory");
    await fs.mkdir(memDir, { recursive: true });
    await fs.writeFile(path.join(memDir, "2026-04-08.md"), "# Daily summary\nDid some things.", "utf-8");

    const result = await readMemorySummary(tmpDir, new Date("2026-04-08T12:00:00Z"));
    expect(result).toBe("# Daily summary\nDid some things.");
  });

  it("returns null when file doesn't exist", async () => {
    const result = await readMemorySummary(tmpDir, new Date("2026-01-01T12:00:00Z"));
    expect(result).toBeNull();
  });
});

// ----- runLearner -----

describe("runLearner", () => {
  let stateDir: string;
  let workspaceDir: string;

  beforeEach(async () => {
    stateDir = await makeTmpDir("learner-state-");
    workspaceDir = await makeTmpDir("learner-ws-");
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
  });

  it("happy path: calls subagent pipeline (run → waitForRun → getSessionMessages → deleteSession) and applies patch", async () => {
    const { routing, audit } = await makeRoutingDeps(stateDir);
    const originalChecksum = routing.getChecksum();

    const patch: JsonPatchOp[] = [
      { op: "replace", path: "/quietHours/start", value: "01:00" },
    ];
    const responseJson = JSON.stringify({ patchOps: patch, reason: "shift quiet hours later" });
    const api = makeSubagentApi(responseJson);
    const deps = makeDeps(stateDir, workspaceDir, api, routing, audit);

    await runLearner(deps);

    expect(api.runtime.subagent.run).toHaveBeenCalledOnce();
    expect(api.runtime.subagent.waitForRun).toHaveBeenCalledOnce();
    expect(api.runtime.subagent.getSessionMessages).toHaveBeenCalledOnce();
    // deleteSession is invoked twice: pre-run cleanup + finally-block cleanup
    expect(api.runtime.subagent.deleteSession).toHaveBeenCalledTimes(2);

    // Patch was applied — rules updated
    expect(routing.getRules().quietHours.start).toBe("01:00");
    expect(routing.getChecksum()).not.toBe(originalChecksum);

    // Audit entry recorded for learner
    const entries = await audit.readSince(0);
    const learnerEntry = entries.find(e => e.source === "learner");
    expect(learnerEntry).toBeDefined();
    expect(learnerEntry?.reason).toBe("shift quiet hours later");
  });

  it("wires context.readPatterns into the prompt (not hardcoded {})", async () => {
    const { routing, audit } = await makeRoutingDeps(stateDir);
    const responseJson = JSON.stringify({ patchOps: [], reason: "no change" });
    const api = makeSubagentApi(responseJson);
    const deps = makeDeps(stateDir, workspaceDir, api, routing, audit);

    // Override readPatterns to return a recognizable marker
    const marker = { eventStats: { eventsPerDay7d: 42 } };
    (deps.context.readPatterns as ReturnType<typeof vi.fn>).mockResolvedValue(marker);

    await runLearner(deps);

    const callArgs = (api.runtime.subagent.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.message).toContain("\"eventsPerDay7d\":42");
    // And the patternsJson section should precede the routing rules section
    const patternsIdx = callArgs.message.indexOf("## Computed Patterns");
    const rulesIdx = callArgs.message.indexOf("## Current Routing Rules");
    expect(patternsIdx).toBeGreaterThan(-1);
    expect(rulesIdx).toBeGreaterThan(patternsIdx);
  });

  it("empty patchOps: does not call applyPatch-producing changes but still completes run", async () => {
    const { routing, audit } = await makeRoutingDeps(stateDir);
    const originalChecksum = routing.getChecksum();
    const responseJson = JSON.stringify({ patchOps: [], reason: "looks good as-is" });
    const api = makeSubagentApi(responseJson);
    const deps = makeDeps(stateDir, workspaceDir, api, routing, audit);

    await runLearner(deps);

    // Rules unchanged
    expect(routing.getChecksum()).toBe(originalChecksum);
    // Reactions still rotated
    expect(deps.reactions.rotate).toHaveBeenCalledOnce();
    expect(deps.reactions.save).toHaveBeenCalledOnce();
  });

  it("unparseable LLM output: no patch applied, still rotates reactions", async () => {
    const { routing, audit } = await makeRoutingDeps(stateDir);
    const originalChecksum = routing.getChecksum();
    const api = makeSubagentApi("This is not JSON at all, just random text.");
    const deps = makeDeps(stateDir, workspaceDir, api, routing, audit);

    await runLearner(deps);

    expect(routing.getChecksum()).toBe(originalChecksum);
    expect(deps.reactions.rotate).toHaveBeenCalledOnce();
  });

  it("still invokes deleteSession on thrown subagent error (finally cleanup)", async () => {
    const { routing, audit } = await makeRoutingDeps(stateDir);
    const api = makeSubagentApi(JSON.stringify({ patchOps: [], reason: "n/a" }));
    // Make waitForRun throw
    (api.runtime.subagent.waitForRun as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("boom"));
    const deps = makeDeps(stateDir, workspaceDir, api, routing, audit);

    await expect(runLearner(deps)).rejects.toThrow("boom");

    // Both the pre-run and the finally-block deleteSession should have fired
    expect(api.runtime.subagent.deleteSession).toHaveBeenCalledTimes(2);
  });

  it("passes locked-key hints from recent user audit into the prompt", async () => {
    const { routing, audit } = await makeRoutingDeps(stateDir);

    // Simulate a recent user edit whose expiresAt is in the future
    const now = Math.floor(Date.now() / 1000);
    await audit.appendEdit({
      ts: now - 1000,
      source: "user",
      docChecksum: "fake",
      diffs: [{ path: "/quietHours/start", from: "22:00", to: "22:30" }],
      expiresAt: now + 86400,
    });

    const api = makeSubagentApi(JSON.stringify({ patchOps: [], reason: "no change" }));
    const deps = makeDeps(stateDir, workspaceDir, api, routing, audit);

    await runLearner(deps);

    const callArgs = (api.runtime.subagent.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.message).toContain("/quietHours/start");
    expect(callArgs.message).toContain("DO NOT modify them");
  });
});
