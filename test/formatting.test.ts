import { describe, it, expect, beforeEach } from "vitest";
import { formatDuration, formatEventBody, formatContextSummary, formatEnrichedMessage } from "../src/pipeline.js";
import { formatAge } from "../src/tools/get-context.js";
import { ContextManager } from "../src/context.js";
import type { DeviceContext, DeviceEvent } from "../src/types.js";
import { makeTmpDir } from "./helpers.js";

// ---------------------------------------------------------------------------
// formatDuration
// ---------------------------------------------------------------------------

describe("formatDuration", () => {
  it("returns '<1m' for 30s", () => {
    expect(formatDuration(30)).toBe("<1m");
  });

  it("returns '<1m' for 0", () => {
    expect(formatDuration(0)).toBe("<1m");
  });

  it("returns '<1m' for 59", () => {
    expect(formatDuration(59)).toBe("<1m");
  });

  it("returns '1m' for 60", () => {
    expect(formatDuration(60)).toBe("1m");
  });

  it("returns '2m' for 120", () => {
    expect(formatDuration(120)).toBe("2m");
  });

  it("returns '60m' for 3599", () => {
    expect(formatDuration(3599)).toBe("60m");
  });

  it("returns '1h' for 3600", () => {
    expect(formatDuration(3600)).toBe("1h");
  });

  it("returns '1h 30m' for 5400", () => {
    expect(formatDuration(5400)).toBe("1h 30m");
  });

  it("returns '2h' for 7200", () => {
    expect(formatDuration(7200)).toBe("2h");
  });
});

// ---------------------------------------------------------------------------
// formatEventBody
// ---------------------------------------------------------------------------

describe("formatEventBody", () => {
  it("formats battery-low with percentage", () => {
    const event: DeviceEvent = {
      subscriptionId: "default.battery-low",
      source: "device.battery",
      data: { level: 0.15 },
      firedAt: 1740000000,
    };
    const result = formatEventBody(event);
    expect(result).toContain("15%");
    expect(result).toContain("Battery");
  });

  it("formats battery-critical with percentage", () => {
    const event: DeviceEvent = {
      subscriptionId: "default.battery-critical",
      source: "device.battery",
      data: { level: 0.05 },
      firedAt: 1740000000,
    };
    const result = formatEventBody(event);
    expect(result).toContain("5%");
    expect(result).toContain("threshold: <10%");
  });

  it("formats battery-low with missing level as '?%'", () => {
    const event: DeviceEvent = {
      subscriptionId: "default.battery-low",
      source: "device.battery",
      data: {},
      firedAt: 1740000000,
    };
    const result = formatEventBody(event);
    expect(result).toContain("?%");
  });

  it("formats daily-health with steps", () => {
    const event: DeviceEvent = {
      subscriptionId: "default.daily-health",
      source: "health.daily",
      data: { stepsToday: 8000 },
      firedAt: 1740000000,
    };
    const result = formatEventBody(event);
    expect(result).toContain("8,000");
    expect(result).toContain("Daily health");
  });

  it("formats daily-health with all fields", () => {
    const event: DeviceEvent = {
      subscriptionId: "default.daily-health",
      source: "health.daily",
      data: {
        stepsToday: 12000,
        distanceMeters: 8500,
        heartRateAvg: 72,
        sleepDurationSeconds: 27000, // 7h 30m
      },
      firedAt: 1740000000,
    };
    const result = formatEventBody(event);
    expect(result).toContain("12,000");
    expect(result).toContain("8.5km");
    expect(result).toContain("72bpm");
    expect(result).toContain("7h 30m");
  });

  it("formats daily-health with no data", () => {
    const event: DeviceEvent = {
      subscriptionId: "default.daily-health",
      source: "health.daily",
      data: {},
      firedAt: 1740000000,
    };
    const result = formatEventBody(event);
    expect(result).toContain("No data");
  });

  it("formats geofence enter", () => {
    const event: DeviceEvent = {
      subscriptionId: "default.geofence",
      source: "geofence.triggered",
      data: { type: 1 },
      metadata: { zoneName: "Home" },
      firedAt: 1740000000,
    };
    const result = formatEventBody(event);
    expect(result).toContain("enter");
    expect(result).toContain("Home");
  });

  it("formats geofence exit", () => {
    const event: DeviceEvent = {
      subscriptionId: "default.geofence",
      source: "geofence.triggered",
      data: { type: 2 },
      metadata: { zoneName: "Office" },
      firedAt: 1740000000,
    };
    const result = formatEventBody(event);
    expect(result).toContain("exit");
    expect(result).toContain("Office");
  });

  it("formats geofence without zone name (no 'undefined' in output)", () => {
    const event: DeviceEvent = {
      subscriptionId: "default.geofence",
      source: "geofence.triggered",
      data: { type: 1 },
      firedAt: 1740000000,
    };
    const result = formatEventBody(event);
    expect(result).not.toContain("undefined");
    expect(result).toContain("enter");
  });

  it("formats health source event", () => {
    const event: DeviceEvent = {
      subscriptionId: "custom.health-hr",
      source: "health.heartRate",
      data: { heartRateAvg: 85 },
      firedAt: 1740000000,
    };
    const result = formatEventBody(event);
    expect(result).toContain("Health event");
    expect(result).toContain("heartRateAvg: 85");
  });

  it("formats unknown/custom event with fallback", () => {
    const event: DeviceEvent = {
      subscriptionId: "custom.something",
      source: "custom.trigger",
      data: { foo: 42 },
      firedAt: 1740000000,
    };
    const result = formatEventBody(event);
    expect(result).toContain("custom.trigger");
    expect(result).toContain("foo: 42");
  });

  it("formats location-change (falls through to default)", () => {
    const event: DeviceEvent = {
      subscriptionId: "default.location-change",
      source: "location.change",
      data: { latitude: 48.1, longitude: 11.5 },
      firedAt: 1740000000,
    };
    const result = formatEventBody(event);
    expect(result).toContain("location.change");
  });

  it("filters _debugFired from output", () => {
    const event: DeviceEvent = {
      subscriptionId: "custom.something",
      source: "custom.trigger",
      data: { foo: 1, _debugFired: 1.0 },
      firedAt: 1740000000,
    };
    const result = formatEventBody(event);
    expect(result).not.toContain("_debugFired");
    expect(result).toContain("foo: 1");
  });
});

// ---------------------------------------------------------------------------
// formatContextSummary
// ---------------------------------------------------------------------------

describe("formatContextSummary", () => {
  const now = Date.now() / 1000;

  it("includes zone and duration", () => {
    const state: DeviceContext = {
      ...ContextManager.empty(),
      activity: {
        ...ContextManager.empty().activity,
        currentZone: "Home",
        zoneEnteredAt: now - 3600,
      },
    };
    const result = formatContextSummary(state);
    expect(result).toContain("At Home");
    expect(result).toContain("since 1h");
  });

  it("includes steps when present", () => {
    const state: DeviceContext = {
      ...ContextManager.empty(),
      device: {
        ...ContextManager.empty().device,
        health: {
          stepsToday: 8000,
          distanceMeters: null,
          heartRateAvg: null,
          restingHeartRate: null,
          hrv: null,
          activeEnergyKcal: null,
          sleepDurationSeconds: null,
          updatedAt: now,
        },
      },
    };
    const result = formatContextSummary(state);
    expect(result).toContain("8,000 steps today");
  });

  it("includes battery when present", () => {
    const state: DeviceContext = {
      ...ContextManager.empty(),
      device: {
        ...ContextManager.empty().device,
        battery: {
          level: 0.65,
          state: "unplugged",
          isLowPowerMode: false,
          updatedAt: now,
        },
      },
    };
    const result = formatContextSummary(state);
    expect(result).toContain("Battery 65%");
    expect(result).toContain("unplugged");
  });

  it("returns 'No context available.' when all empty", () => {
    const state = ContextManager.empty();
    const result = formatContextSummary(state);
    expect(result).toBe("No context available.");
  });

  it("returns 'No context available.' for 0 steps (falsy)", () => {
    const state: DeviceContext = {
      ...ContextManager.empty(),
      device: {
        ...ContextManager.empty().device,
        health: {
          stepsToday: 0,
          distanceMeters: null,
          heartRateAvg: null,
          restingHeartRate: null,
          hrv: null,
          activeEnergyKcal: null,
          sleepDurationSeconds: null,
          updatedAt: now,
        },
      },
    };
    const result = formatContextSummary(state);
    // stepsToday=0 is falsy, so the `if (state.device.health?.stepsToday)` check fails
    expect(result).toBe("No context available.");
  });

  it("includes Battery 0% (battery object is truthy even at 0%)", () => {
    const state: DeviceContext = {
      ...ContextManager.empty(),
      device: {
        ...ContextManager.empty().device,
        battery: {
          level: 0,
          state: "charging",
          isLowPowerMode: false,
          updatedAt: now,
        },
      },
    };
    const result = formatContextSummary(state);
    expect(result).toContain("Battery 0%");
  });
});

// ---------------------------------------------------------------------------
// formatEnrichedMessage
// ---------------------------------------------------------------------------

describe("formatEnrichedMessage", () => {
  let tmpDir: string;
  let ctx: ContextManager;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
    ctx = new ContextManager(tmpDir);
    ctx.applySnapshot({
      battery: { level: 0.5, state: "unplugged", isLowPowerMode: false },
    });
  });

  it("composes prefix, event body, and context", () => {
    const event: DeviceEvent = {
      subscriptionId: "default.battery-low",
      source: "device.battery",
      data: { level: 0.15 },
      firedAt: 1740000000,
    };
    const result = formatEnrichedMessage(event, ctx);
    expect(result).toContain("[BetterClaw device event");
    expect(result).toContain("15%");
    expect(result).toContain("Current context:");
    expect(result).toContain("Battery 50%");
  });

  it("uses debug prefix for events with _debugFired", () => {
    const event: DeviceEvent = {
      subscriptionId: "default.battery-low",
      source: "device.battery",
      data: { level: 0.15, _debugFired: 1.0 },
      firedAt: 1740000000,
    };
    const result = formatEnrichedMessage(event, ctx);
    expect(result).toContain("[DEBUG test event fired manually");
    expect(result).toContain("MUST respond");
  });
});

// ---------------------------------------------------------------------------
// formatAge
// ---------------------------------------------------------------------------

describe("formatAge", () => {
  it("returns '30s ago' for 30", () => {
    expect(formatAge(30)).toBe("30s ago");
  });

  it("returns '0s ago' for 0", () => {
    expect(formatAge(0)).toBe("0s ago");
  });

  it("returns '2m ago' for 120", () => {
    expect(formatAge(120)).toBe("2m ago");
  });

  it("returns '59s ago' for 59", () => {
    expect(formatAge(59)).toBe("59s ago");
  });

  it("returns '1m ago' for 60", () => {
    expect(formatAge(60)).toBe("1m ago");
  });

  it("returns '2h ago' for 7200", () => {
    expect(formatAge(7200)).toBe("2h ago");
  });

  it("returns '2d ago' for 172800", () => {
    expect(formatAge(172800)).toBe("2d ago");
  });

  it("clamps negative to '0s ago'", () => {
    expect(formatAge(-10)).toBe("0s ago");
  });
});
