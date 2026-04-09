import { describe, it, expect, vi, beforeEach } from "vitest";
import { scanPendingReactions } from "../../src/reaction-scanner.js";
import type { ScanDeps } from "../../src/reaction-scanner.js";
import type { ReactionEntry } from "../../src/types.js";

vi.mock("../../src/diagnostic-logger.js", () => ({
  dlog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const pushedAt = 1712600000;
const messageSummary = "[BetterClaw device event — battery.critical] Level: 5%";

function pendingReaction(overrides: Partial<ReactionEntry> = {}): ReactionEntry {
  return {
    subscriptionId: "default.battery-critical",
    source: "device.battery",
    pushedAt,
    messageSummary,
    status: "pending",
    ...overrides,
  };
}

function makeScanDeps(
  pending: ReactionEntry[],
  transcriptMessages: Array<{ role: string; content: string; timestamp?: number }>,
  classificationContent: string = '{"status":"engaged","reason":"user asked follow-up"}',
): ScanDeps {
  // Track call count to getSessionMessages to return different data per call
  let getSessionCallCount = 0;

  return {
    api: {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      runtime: {
        subagent: {
          run: vi.fn(async () => ({ runId: "classify-run" })),
          waitForRun: vi.fn(async () => {}),
          getSessionMessages: vi.fn(async () => {
            getSessionCallCount++;
            if (getSessionCallCount === 1) {
              // First call: fetch main session transcript
              return { messages: transcriptMessages };
            }
            // Subsequent calls: classification subagent response
            return {
              messages: [
                { role: "user", content: "classify this" },
                { role: "assistant", content: classificationContent },
              ],
            };
          }),
          deleteSession: vi.fn(async () => {}),
        },
      },
    } as unknown as ScanDeps["api"],
    reactions: {
      getPending: vi.fn(() => pending),
      classify: vi.fn(),
      save: vi.fn(async () => true),
    } as unknown as ScanDeps["reactions"],
  };
}

describe("scanPendingReactions", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns early when no pending reactions", async () => {
    const deps = makeScanDeps([], []);

    await scanPendingReactions(deps);

    expect(deps.api.runtime.subagent.getSessionMessages).not.toHaveBeenCalled();
    expect(deps.reactions.save).not.toHaveBeenCalled();
  });

  it("happy path: finds push in transcript, classifies, records", async () => {
    const transcript = [
      { role: "user", content: "What's the weather?", timestamp: pushedAt - 60 },
      {
        role: "assistant",
        content: `[BetterClaw device event — battery.critical] Level: 5% — battery is critically low`,
        timestamp: pushedAt,
      },
      { role: "user", content: "Oh no, let me charge it", timestamp: pushedAt + 10 },
    ];

    const deps = makeScanDeps([pendingReaction()], transcript);

    await scanPendingReactions(deps);

    // Classification subagent was invoked
    expect(deps.api.runtime.subagent.run).toHaveBeenCalledOnce();

    // Reaction was classified
    expect(deps.reactions.classify).toHaveBeenCalledWith(
      "default.battery-critical",
      pushedAt,
      "engaged",
      "user asked follow-up",
    );

    // Results were saved
    expect(deps.reactions.save).toHaveBeenCalledOnce();
  });

  it("skips reaction when no transcript match found", async () => {
    // Transcript has no BetterClaw markers
    const transcript = [
      { role: "user", content: "Hello", timestamp: pushedAt - 10 },
      { role: "assistant", content: "Hi there!", timestamp: pushedAt },
    ];

    const deps = makeScanDeps([pendingReaction()], transcript);

    await scanPendingReactions(deps);

    // No classification attempt
    expect(deps.api.runtime.subagent.run).not.toHaveBeenCalled();
    expect(deps.reactions.classify).not.toHaveBeenCalled();

    // Still saves (the scan completes)
    expect(deps.reactions.save).toHaveBeenCalledOnce();
  });

  it("continues processing other reactions when one classification fails", async () => {
    const reaction1 = pendingReaction({ subscriptionId: "sub-1", pushedAt: pushedAt });
    const reaction2 = pendingReaction({ subscriptionId: "sub-2", pushedAt: pushedAt + 100 });

    const transcript = [
      {
        role: "assistant",
        content: `[BetterClaw device event — battery.critical] Level: 5% — first event`,
        timestamp: pushedAt,
      },
      { role: "user", content: "Got it", timestamp: pushedAt + 5 },
      {
        role: "assistant",
        content: `[BetterClaw device event — battery.critical] Level: 5% — second event`,
        timestamp: pushedAt + 100,
      },
      { role: "user", content: "Thanks", timestamp: pushedAt + 105 },
    ];

    let getSessionCallCount = 0;
    const deps: ScanDeps = {
      api: {
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        runtime: {
          subagent: {
            run: vi.fn(async () => {
              // First classification throws, second succeeds
              if ((deps.api.runtime.subagent.run as ReturnType<typeof vi.fn>).mock.calls.length === 1) {
                throw new Error("subagent crashed");
              }
              return { runId: "classify-run-2" };
            }),
            waitForRun: vi.fn(async () => {}),
            getSessionMessages: vi.fn(async () => {
              getSessionCallCount++;
              if (getSessionCallCount === 1) {
                return { messages: transcript };
              }
              return {
                messages: [
                  { role: "assistant", content: '{"status":"ignored","reason":"user changed topic"}' },
                ],
              };
            }),
            deleteSession: vi.fn(async () => {}),
          },
        },
      } as unknown as ScanDeps["api"],
      reactions: {
        getPending: vi.fn(() => [reaction1, reaction2]),
        classify: vi.fn(),
        save: vi.fn(async () => true),
      } as unknown as ScanDeps["reactions"],
    };

    await scanPendingReactions(deps);

    // Second reaction should still be classified despite first failing
    expect(deps.reactions.classify).toHaveBeenCalledOnce();
    expect(deps.reactions.classify).toHaveBeenCalledWith(
      "sub-2",
      pushedAt + 100,
      "ignored",
      "user changed topic",
    );

    // Save still called
    expect(deps.reactions.save).toHaveBeenCalledOnce();
  });
});
