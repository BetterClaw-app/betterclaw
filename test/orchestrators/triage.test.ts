import { describe, it, expect, vi } from "vitest";
import { triageEvent } from "../../src/triage.js";
import type { ContextManager } from "../../src/context.js";
import type { DeviceEvent, TriageProfile } from "../../src/types.js";

vi.mock("../../src/diagnostic-logger.js", () => ({
  dlog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function makeEvent(overrides: Partial<DeviceEvent> = {}): DeviceEvent {
  return {
    subscriptionId: "default.battery-critical",
    source: "device.battery",
    data: { level: 0.05 },
    firedAt: Date.now() / 1000,
    ...overrides,
  };
}

function makeContext(): ContextManager {
  return {
    get: () => ({
      device: { battery: { level: 0.85, state: "unplugged" } },
      activity: { currentZone: "home" },
    }),
    readPatterns: vi.fn(async () => null),
  } as unknown as ContextManager;
}

const profile: TriageProfile = {
  summary: "User prefers minimal interruptions",
  interruptionTolerance: "low",
  computedAt: Date.now() / 1000,
};

const config = { triageModel: "openai/gpt-4o-mini" };


describe("triageEvent", () => {
  it("returns push decision on successful API call", async () => {
    const body = { push: true, reason: "critical battery", priority: "high" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify(body) } }],
        }),
      })),
    );

    const result = await triageEvent(makeEvent(), makeContext(), profile, config, async () => "sk-test");

    expect(result.push).toBe(true);
    expect(result.reason).toBe("critical battery");
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

    const result = await triageEvent(makeEvent(), makeContext(), profile, config, async () => "sk-test");

    expect(result.push).toBe(false);
    expect(result.reason).toContain("failed to parse");
  });

  it("returns drop when API key is missing", async () => {
    const result = await triageEvent(makeEvent(), makeContext(), profile, config, async () => undefined);

    expect(result.push).toBe(false);
    expect(result.reason).toContain("no API key");
  });

  it("returns drop on non-OK HTTP response (429)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 429 })),
    );

    const result = await triageEvent(makeEvent(), makeContext(), profile, config, async () => "sk-test");

    expect(result.push).toBe(false);
    expect(result.reason).toContain("429");
  });

  it("returns drop on network error (fetch throws)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network failure");
      }),
    );

    const result = await triageEvent(makeEvent(), makeContext(), profile, config, async () => "sk-test");

    expect(result.push).toBe(false);
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

    const result = await triageEvent(makeEvent(), makeContext(), profile, config, async () => "sk-test");

    expect(result.push).toBe(false);
    expect(result.reason).toContain("empty triage response");
  });

  it("sends correct model name (strips provider prefix)", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"push":false,"reason":"test","priority":"low"}' } }],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await triageEvent(makeEvent(), makeContext(), profile, { triageModel: "openai/gpt-4o-mini" }, async () => "sk-test");

    const callBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(callBody.model).toBe("gpt-4o-mini");
  });
});
