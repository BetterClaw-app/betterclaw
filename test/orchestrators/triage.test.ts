import { describe, it, expect, vi } from "vitest";
import { triageEvent } from "../../src/triage.js";
import type { ContextManager } from "../../src/context.js";
import type { DeviceEvent } from "../../src/types.js";

vi.mock("../../src/diagnostic-logger.js", () => ({
  dlog: { info: vi.fn(), warn: vi.fn(), warning: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function makeEvent(overrides: Partial<DeviceEvent> = {}): DeviceEvent {
  return {
    subscriptionId: "default.daily-health",
    source: "health.daily",
    data: { stepsToday: 8000 },
    firedAt: Date.now() / 1000,
    ...overrides,
  };
}

function makeContext(): ContextManager {
  return {
    get: () => ({
      device: { location: { label: "home" } },
      activity: { currentZone: "home" },
    }),
    readPatterns: vi.fn(async () => null),
  } as unknown as ContextManager;
}

const config = { triageModel: "openai/gpt-4o-mini" };
const quietHours = { start: "22:00", end: "07:00", tz: "auto" };
const currentLocalTime = "14:00";

describe("triageEvent", () => {
  it("returns push action on successful API call", async () => {
    const body = { action: "push", reason: "health event is relevant", priority: "high" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify(body) } }],
        }),
      })),
    );

    const result = await triageEvent(
      makeEvent(), makeContext(), [], new Set(), [], quietHours, currentLocalTime,
      config, async () => "sk-test",
    );

    expect(result.action).toBe("push");
    expect(result.reason).toBe("health event is relevant");
    expect(result.priority).toBe("high");
  });

  it("falls back to drop on malformed JSON response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "not json at all" } }],
        }),
      })),
    );

    const result = await triageEvent(
      makeEvent(), makeContext(), [], new Set(), [], quietHours, currentLocalTime,
      config, async () => "sk-test",
    );

    expect(result.action).toBe("drop");
    expect(result.reason).toContain("failed to parse");
  });

  it("returns drop when API key is missing", async () => {
    const result = await triageEvent(
      makeEvent(), makeContext(), [], new Set(), [], quietHours, currentLocalTime,
      config, async () => undefined,
    );

    expect(result.action).toBe("drop");
    expect(result.reason).toContain("no API key");
  });

  it("uses OpenClaw model runner when provided and no triageApiBase override is set", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const runModel = vi.fn(async () => JSON.stringify({
      action: "notify",
      reason: "primary model says notify",
      priority: "normal",
    }));
    const resolveApiKey = vi.fn(async () => undefined);

    const result = await triageEvent(
      makeEvent(), makeContext(), [], new Set(), [], quietHours, currentLocalTime,
      { triageModel: "anthropic/claude-sonnet-4-5" }, resolveApiKey, runModel,
    );

    expect(result.action).toBe("notify");
    expect(result.reason).toBe("primary model says notify");
    expect(runModel).toHaveBeenCalledWith(expect.objectContaining({
      model: "anthropic/claude-sonnet-4-5",
      useModelOverride: true,
    }));
    expect(resolveApiKey).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not request a model override when triage uses the OpenClaw default model", async () => {
    const runModel = vi.fn(async () => JSON.stringify({
      action: "push",
      reason: "default session model says push",
      priority: "normal",
    }));

    await triageEvent(
      makeEvent(), makeContext(), [], new Set(), [], quietHours, currentLocalTime,
      { triageModel: "anthropic/claude-sonnet-4-5", triageModelUsesOpenClawDefault: true },
      async () => undefined,
      runModel,
    );

    expect(runModel).toHaveBeenCalledWith(expect.objectContaining({
      model: "anthropic/claude-sonnet-4-5",
      useModelOverride: false,
    }));
  });

  it("uses direct OpenAI-compatible HTTP when triageApiBase is set even if a model runner exists", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"action":"push","reason":"http override","priority":"low"}' } }],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const runModel = vi.fn(async () => {
      throw new Error("should not run");
    });

    const result = await triageEvent(
      makeEvent(), makeContext(), [], new Set(), [], quietHours, currentLocalTime,
      { triageModel: "openai/gpt-4o-mini", triageApiBase: "http://localhost:11434/v1" },
      async () => "sk-test",
      runModel,
    );

    expect(result.action).toBe("push");
    expect(result.reason).toBe("http override");
    expect(runModel).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalled();
  });

  it("returns drop on non-OK HTTP response (429)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 429, text: async () => "rate limited" })),
    );

    const result = await triageEvent(
      makeEvent(), makeContext(), [], new Set(), [], quietHours, currentLocalTime,
      config, async () => "sk-test",
    );

    expect(result.action).toBe("drop");
    expect(result.reason).toContain("429");
  });

  it("returns drop on network error (fetch throws)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network failure");
      }),
    );

    const result = await triageEvent(
      makeEvent(), makeContext(), [], new Set(), [], quietHours, currentLocalTime,
      config, async () => "sk-test",
    );

    expect(result.action).toBe("drop");
    expect(result.reason).toContain("triage call failed");
  });

  it("returns drop on empty response content", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ choices: [{ message: { content: "" } }] }),
      })),
    );

    const result = await triageEvent(
      makeEvent(), makeContext(), [], new Set(), [], quietHours, currentLocalTime,
      config, async () => "sk-test",
    );

    expect(result.action).toBe("drop");
    expect(result.reason).toContain("empty triage response");
  });

  it("sends correct model name (strips provider prefix)", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"action":"drop","reason":"test","priority":"low"}' } }],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await triageEvent(
      makeEvent(), makeContext(), [], new Set(), [], quietHours, currentLocalTime,
      { triageModel: "openai/gpt-4o-mini" }, async () => "sk-test",
    );

    const callBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(callBody.model).toBe("gpt-4o-mini");
  });
});
