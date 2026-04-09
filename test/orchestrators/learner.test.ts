import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readMemorySummary, runLearner } from "../../src/learner.js";
import type { RunLearnerDeps } from "../../src/learner.js";
import { makeTmpDir } from "../helpers.js";

vi.mock("../../src/diagnostic-logger.js", () => ({
  dlog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
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

function makeDeps(
  stateDir: string,
  workspaceDir: string,
  api: RunLearnerDeps["api"],
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
  };
}

describe("readMemorySummary", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir("learner-mem-");
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

describe("runLearner", () => {
  let stateDir: string;
  let workspaceDir: string;

  beforeEach(async () => {
    stateDir = await makeTmpDir("learner-state-");
    workspaceDir = await makeTmpDir("learner-ws-");
  });

  it("happy path: reads data, calls subagent, saves profile to disk", async () => {
    const profileJson = JSON.stringify({
      summary: "Prefers minimal interruptions",
      interruptionTolerance: "low",
    });
    const api = makeSubagentApi(profileJson);
    const deps = makeDeps(stateDir, workspaceDir, api);

    await runLearner(deps);

    // Subagent was called
    expect(api.runtime.subagent.run).toHaveBeenCalledOnce();
    expect(api.runtime.subagent.waitForRun).toHaveBeenCalledOnce();

    // Profile was saved to disk
    const saved = JSON.parse(
      await fs.readFile(path.join(stateDir, "triage-profile.json"), "utf-8"),
    );
    expect(saved.summary).toBe("Prefers minimal interruptions");
    expect(saved.interruptionTolerance).toBe("low");
  });

  it("empty inputs: still calls subagent with empty-data prompt", async () => {
    const profileJson = JSON.stringify({
      summary: "Default profile",
      interruptionTolerance: "normal",
    });
    const api = makeSubagentApi(profileJson);
    const deps = makeDeps(stateDir, workspaceDir, api);

    await runLearner(deps);

    expect(api.runtime.subagent.run).toHaveBeenCalledOnce();
    const callArgs = (api.runtime.subagent.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.message).toContain("No events in the last 24 hours");
  });

  it("rotates reactions after successful run", async () => {
    const profileJson = JSON.stringify({
      summary: "Test",
      interruptionTolerance: "normal",
    });
    const api = makeSubagentApi(profileJson);
    const deps = makeDeps(stateDir, workspaceDir, api);

    await runLearner(deps);

    expect(deps.reactions.rotate).toHaveBeenCalledOnce();
    expect(deps.reactions.save).toHaveBeenCalledOnce();
  });

  it("does not save profile when LLM returns unparseable content", async () => {
    const api = makeSubagentApi("This is not JSON at all, just random text.");
    const deps = makeDeps(stateDir, workspaceDir, api);

    await runLearner(deps);

    // Profile file should not exist
    await expect(
      fs.access(path.join(stateDir, "triage-profile.json")),
    ).rejects.toThrow();

    // But reactions still rotate (learner completes)
    expect(deps.reactions.rotate).toHaveBeenCalledOnce();
  });
});
