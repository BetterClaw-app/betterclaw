import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import {
  hmacHost, hmacUrlHost, hmacId, allowPlain, drop,
  redactEntry, MANIFEST,
} from "../src/redactor.js";

describe("redactor strategies", () => {
  const k1 = randomBytes(32);
  const k2 = randomBytes(32);

  it("hmacHost is deterministic per key and input", () => {
    expect(hmacHost("api.openai.com", k1)).toBe(hmacHost("api.openai.com", k1));
    expect(hmacHost("api.openai.com", k1)).not.toBe(hmacHost("api.openai.com", k2));
    expect(hmacHost("api.openai.com", k1)).not.toBe(hmacHost("api.anthropic.com", k1));
  });

  it("hmacHost output is hmac:<16-hex>", () => {
    const out = hmacHost("x", k1);
    expect(out).toMatch(/^hmac:[0-9a-f]{16}$/);
  });

  it("hmacId output is hmac:<12-hex>", () => {
    expect(hmacId("s", k1)).toMatch(/^hmac:[0-9a-f]{12}$/);
  });

  it("hmacUrlHost extracts host from URL", () => {
    expect(hmacUrlHost("https://api.openai.com/v1/chat?tok=x", k1))
      .toBe(hmacHost("api.openai.com", k1));
  });

  it("hmacUrlHost returns 'hmac:invalid' on bad URL", () => {
    expect(hmacUrlHost("not a url", k1)).toBe("hmac:invalid");
  });

  it("allowPlain passes scalars and truncates oversize strings", () => {
    expect(allowPlain(42)).toBe(42);
    expect(allowPlain("x")).toBe("x");
    expect(allowPlain(true)).toBe(true);
    expect(allowPlain(null)).toBe(null);
    const huge = "x".repeat(10_000);
    const out = allowPlain(huge) as string;
    expect(out.length).toBeLessThan(huge.length);
    expect(out).toMatch(/truncated/);
  });

  it("allowPlain survives Date / URL / undefined / BigInt", () => {
    expect(typeof allowPlain(new Date("2026-01-01"))).toBe("string");
    expect(typeof allowPlain(new URL("https://x.com"))).toBe("string");
    expect(allowPlain(undefined)).toBe("undefined");
    expect(allowPlain(1n)).toBe("1");
  });

  it("drop returns undefined", () => {
    expect(drop()).toBeUndefined();
  });
});

describe("redactEntry", () => {
  const key = randomBytes(32);
  const allOn = {
    connection: true, heartbeat: true, commands: true, dns: true,
    lifecycle: true, battery: true,
    subscriptions: true, health: true, location: true, geofence: true,
  };

  it("drops entries from unknown sources", () => {
    expect(redactEntry({ timestamp: 1, level: "info", source: "plugin.unknown", event: "x", message: "m" }, allOn, key)).toBeNull();
  });

  it("drops entries whose base export category is disabled", () => {
    const entry = { timestamp: 1, level: "info" as const, source: "plugin.service", event: "loaded", message: "m", data: {} };
    expect(redactEntry(entry, { ...allOn, lifecycle: false }, key)).toBeNull();
  });

  it("keeps entry but drops field when field-implied category is disabled", () => {
    const entry = {
      timestamp: 1, level: "info" as const, source: "plugin.context", event: "info",
      message: "m", data: { heartRate: 72, lat: 52.5 },
    };
    const res = redactEntry(entry, { ...allOn, location: false }, key);
    expect(res).not.toBeNull();
    const data = JSON.parse(res!.data!);
    expect(data).not.toHaveProperty("lat");  // dropped (location disabled)
    expect(data).not.toHaveProperty("heartRate");  // allowPlain would pass it, but heartRate is in drop list
  });

  it("applies strategies per manifest", () => {
    const entry = {
      timestamp: 1, level: "info" as const, source: "plugin.rpc", event: "ping.received",
      message: "m", data: { host: "api.x.com", tier: "free", sessionId: "abc-123" },
    };
    const res = redactEntry(entry, allOn, key);
    const data = JSON.parse(res!.data!);
    expect(data.host).toMatch(/^hmac:[0-9a-f]{16}$/);
    expect(data.sessionId).toMatch(/^hmac:[0-9a-f]{12}$/);
    expect(data.tier).toBe("free");  // allowPlain
  });

  it("drops unlisted keys", () => {
    const entry = {
      timestamp: 1, level: "info" as const, source: "plugin.rpc", event: "ping.received",
      message: "m", data: { tier: "free", totallyRandomKey: "leak" },
    };
    const res = redactEntry(entry, allOn, key);
    const data = JSON.parse(res!.data!);
    expect(data).not.toHaveProperty("totallyRandomKey");
    expect(data.tier).toBe("free");
  });

  it("serializes data as JSON string, not object", () => {
    const entry = {
      timestamp: 1, level: "info" as const, source: "plugin.service", event: "loaded",
      message: "m", data: { phase: "init", success: true },
    };
    const res = redactEntry(entry, allOn, key);
    expect(typeof res!.data).toBe("string");
    expect(JSON.parse(res!.data!)).toEqual({ phase: "init", success: true });
  });

  it("isolates entries that would throw during redaction", () => {
    // Circular ref in data — JSON.stringify would throw
    const circular: Record<string, unknown> = { tier: "free" };
    circular.self = circular;
    const entry = {
      timestamp: 1, level: "info" as const, source: "plugin.rpc", event: "ping.received",
      message: "m", data: circular,
    };
    expect(redactEntry(entry, allOn, key)).toBeNull();
  });

  it("applies hmacUrlHost through redactEntry on url-shaped keys", () => {
    const entry = {
      timestamp: 1, level: "info" as const, source: "plugin.rpc", event: "ping.received",
      message: "m", data: { url: "https://api.openai.com/v1/chat?tok=secret" },
    };
    const res = redactEntry(entry, allOn, key);
    const data = JSON.parse(res!.data!);
    expect(data.url).toMatch(/^hmac:[0-9a-f]{16}$/);
  });

  it("truncates oversize allowPlain values through redactEntry", () => {
    const entry = {
      timestamp: 1, level: "info" as const, source: "plugin.rpc", event: "ping.received",
      message: "m", data: { tier: "x".repeat(10_000) },
    };
    const res = redactEntry(entry, allOn, key);
    const data = JSON.parse(res!.data!);
    expect(data.tier.length).toBeLessThan(10_000);
    expect(data.tier).toMatch(/truncated/);
  });

  it("drops non-string values passed to hmac* strategies", () => {
    const entry = {
      timestamp: 1, level: "info" as const, source: "plugin.rpc", event: "ping.received",
      message: "m", data: { host: 12345 as unknown as string, tier: "free" },
    };
    const res = redactEntry(entry, allOn, key);
    const data = JSON.parse(res!.data!);
    expect(data).not.toHaveProperty("host");
    expect(data.tier).toBe("free");
  });

  it("MANIFEST has positive integer manifestVersion", () => {
    expect(Number.isInteger(MANIFEST.manifestVersion)).toBe(true);
    expect(MANIFEST.manifestVersion).toBeGreaterThan(0);
  });
});
