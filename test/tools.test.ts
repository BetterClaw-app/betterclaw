import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createCheckTierTool } from "../src/tools/check-tier.js";
import { makeTmpDir } from "./helpers.js";
import { createGetContextTool } from "../src/tools/get-context.js";
import { ContextManager } from "../src/context.js";

function makeCtx(tier: "free" | "premium" | null): ContextManager {
  const ctx = new ContextManager("/tmp/test-check-tier");
  if (tier) {
    ctx.setRuntimeState({ tier, smartMode: tier !== "free" });
  }
  return ctx;
}

describe("check_tier tool", () => {
  const defaultState = () => ({ calibrating: false });

  it("returns premium tier with node command instructions", async () => {
    const tool = createCheckTierTool(makeCtx("premium"), defaultState);
    const result = await tool.execute("test-id", {});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.tier).toBe("premium");
    expect(parsed.dataPath).toContain("node commands");
    expect(parsed.dataPath).toContain("location.get");
    expect(parsed.cacheUntil).toBeGreaterThan(Date.now() / 1000);
    expect(parsed.cacheInstruction).toContain("memory");
  });

  it("returns free tier with get_context instructions", async () => {
    const tool = createCheckTierTool(makeCtx("free"), defaultState);
    const result = await tool.execute("test-id", {});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.tier).toBe("free");
    expect(parsed.dataPath).toContain("get_context");
    expect(parsed.dataPath).toContain("cached snapshot");
  });

  it("returns unknown when tier is null (no ping received)", async () => {
    const tool = createCheckTierTool(makeCtx(null), defaultState);
    const result = await tool.execute("test-id", {});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.tier).toBe("unknown");
    expect(parsed.cacheUntil - Date.now() / 1000).toBeLessThan(120);
  });

  it("includes calibrating flag when system is calibrating", async () => {
    const endsAt = Date.now() / 1000 + 86400 * 2;
    const tool = createCheckTierTool(makeCtx("premium"), () => ({
      calibrating: true,
      calibrationEndsAt: endsAt,
    }));
    const result = await tool.execute("test-id", {});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.calibrating).toBe(true);
    expect(parsed.calibrationEndsAt).toBeGreaterThan(Date.now() / 1000);
  });

  it("does NOT include any device data", async () => {
    const ctx = makeCtx("premium");
    ctx.applySnapshot({
      battery: { level: 0.5, state: "unplugged", isLowPowerMode: false },
      location: { latitude: 48.1, longitude: 11.5 },
    });
    const tool = createCheckTierTool(ctx, defaultState);
    const result = await tool.execute("test-id", {});
    const text = result.content[0].text;
    expect(text).not.toContain("48.1");
    expect(text).not.toContain("11.5");
    expect(text).not.toContain('"level"');
    expect(text).not.toContain("0.5");
  });
});

describe("get_context tool", () => {
  let tmpDir: string;
  let ctx: ContextManager;

  beforeEach(async () => {
    tmpDir = await makeTmpDir("betterclaw-tool-");
    ctx = new ContextManager(tmpDir);
  });

  it("includes tier and smartMode", async () => {
    ctx.setRuntimeState({ tier: "premium", smartMode: true });
    const tool = createGetContextTool(ctx);
    const result = await tool.execute("test", {});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.tierHint.tier).toBe("premium");
    expect(parsed.smartMode).toBe(true);
  });

  it("includes timestamps in device sections (free tier)", async () => {
    ctx.setRuntimeState({ tier: "free", smartMode: false });
    ctx.updateFromEvent({
      subscriptionId: "bat",
      source: "device.battery",
      data: { level: 0.5 },
      firedAt: 1740000100,
    });
    const tool = createGetContextTool(ctx);
    const result = await tool.execute("test", {});
    const parsed = JSON.parse(result.content[0].text);
    // Free tier always gets full data regardless of age
    expect(parsed.device.battery.level).toBe(0.5);
  });

  it("includes triage profile summary when profile exists on disk", async () => {
    const profile = {
      eventPreferences: {},
      lifeContext: "test",
      interruptionTolerance: "normal",
      timePreferences: {},
      sensitivityThresholds: {},
      locationRules: {},
      summary: "Test profile",
      computedAt: 1740000000,
    };
    await fs.writeFile(path.join(tmpDir, "triage-profile.json"), JSON.stringify(profile), "utf-8");
    const tool = createGetContextTool(ctx, tmpDir);
    const result = await tool.execute("test", {});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.triageProfile.summary).toBe("Test profile");
  });

  it("returns null triage profile when not provided", async () => {
    const tool = createGetContextTool(ctx);
    const result = await tool.execute("test", {});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.triageProfile).toBeNull();
  });
});

describe("createGetContextTool output shape", () => {
  it("premium + smartMode + battery snapshot returns all expected top-level keys", async () => {
    const tmpDir = await makeTmpDir("betterclaw-shape-");
    const ctx = new ContextManager(tmpDir);
    ctx.setRuntimeState({ tier: "premium", smartMode: true });
    const recentTs = Date.now() / 1000 - 10;
    ctx.applySnapshot(
      { battery: { level: 0.8, state: "charging", isLowPowerMode: false } },
      recentTs,
    );

    const tool = createGetContextTool(ctx);
    const result = await tool.execute("test", {});
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed).toHaveProperty("tierHint");
    expect(parsed).toHaveProperty("device");
    expect(parsed).toHaveProperty("activity");
    expect(parsed).toHaveProperty("meta");
    expect(parsed).toHaveProperty("smartMode", true);
    expect(parsed.tierHint.tier).toBe("premium");
  });
});

describe("get_context stale data hiding (deviceFieldOrPointer)", () => {
  let tmpDir: string;
  let ctx: ContextManager;

  beforeEach(async () => {
    tmpDir = await makeTmpDir("betterclaw-dfop-");
    ctx = new ContextManager(tmpDir);
    ctx.setRuntimeState({ tier: "premium", smartMode: true });
  });

  it("premium + stale battery (>900s) returns pointer with stale:true", async () => {
    const oldTs = Date.now() / 1000 - 1200; // 20 min ago, threshold is 900s
    ctx.applySnapshot(
      { battery: { level: 0.5, state: "unplugged", isLowPowerMode: false } },
      oldTs,
    );

    const tool = createGetContextTool(ctx);
    const result = await tool.execute("test", {});
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.device.battery.stale).toBe(true);
    expect(parsed.device.battery.freshCommand).toBe("device.battery");
    expect(parsed.device.battery.ageHuman).toContain("m ago");
    expect(parsed.device.battery.level).toBeUndefined();
  });

  it("premium + fresh battery (<900s) returns data with dataAgeSeconds", async () => {
    const recentTs = Date.now() / 1000 - 60; // 1 min ago
    ctx.applySnapshot(
      { battery: { level: 0.8, state: "charging", isLowPowerMode: false } },
      recentTs,
    );

    const tool = createGetContextTool(ctx);
    const result = await tool.execute("test", {});
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.device.battery.stale).toBeUndefined();
    expect(parsed.device.battery.level).toBe(0.8);
    expect(parsed.device.battery.dataAgeSeconds).toBeLessThan(120);
  });

  it("premium + stale location (>600s) returns pointer", async () => {
    const oldTs = Date.now() / 1000 - 900; // 15 min ago, threshold is 600s
    ctx.applySnapshot({ location: { latitude: 48.1, longitude: 11.5 } }, oldTs);

    const tool = createGetContextTool(ctx);
    const result = await tool.execute("test", {});
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.device.location.stale).toBe(true);
    expect(parsed.device.location.freshCommand).toBe("location.get");
    expect(parsed.device.location.latitude).toBeUndefined();
  });

  it("premium + stale health (>3600s) returns pointer", async () => {
    const oldTs = Date.now() / 1000 - 5400; // 90 min ago, threshold is 3600s
    ctx.applySnapshot({ health: { stepsToday: 8000 } }, oldTs);

    const tool = createGetContextTool(ctx);
    const result = await tool.execute("test", {});
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.device.health.stale).toBe(true);
    expect(parsed.device.health.freshCommand).toBe("health.summary");
    expect(parsed.device.health.stepsToday).toBeUndefined();
  });

  it("free tier returns data regardless of age", async () => {
    ctx.setRuntimeState({ tier: "free", smartMode: false });
    const oldTs = Date.now() / 1000 - 5400; // 90 min ago
    ctx.applySnapshot(
      { battery: { level: 0.3, state: "unplugged", isLowPowerMode: true } },
      oldTs,
    );

    const tool = createGetContextTool(ctx);
    const result = await tool.execute("test", {});
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.device.battery.level).toBe(0.3);
    expect(parsed.device.battery.stale).toBeUndefined();
  });

  it("null data returns null (no pointer)", async () => {
    // No snapshot applied — all device fields should be null
    const tool = createGetContextTool(ctx);
    const result = await tool.execute("test", {});
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.device.battery).toBeNull();
    expect(parsed.device.location).toBeNull();
    expect(parsed.device.health).toBeNull();
  });
});

describe("get_context stale data hiding (premium)", () => {
  let tmpDir: string;
  let ctx: ContextManager;

  beforeEach(async () => {
    tmpDir = await makeTmpDir("betterclaw-stale-");
    ctx = new ContextManager(tmpDir);
    ctx.setRuntimeState({ tier: "premium", smartMode: true });
  });

  it("hides stale location on premium and shows pointer", async () => {
    // Set location with old timestamp (2 hours ago)
    const twoHoursAgo = Date.now() / 1000 - 7200;
    ctx.applySnapshot({ location: { latitude: 52.47, longitude: 13.43 } }, twoHoursAgo);

    const tool = createGetContextTool(ctx);
    const result = await tool.execute("test", {});
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.device.location.stale).toBe(true);
    expect(parsed.device.location.freshCommand).toBe("location.get");
    expect(parsed.device.location.ageHuman).toContain("h ago");
    // Must NOT contain actual coordinates
    expect(parsed.device.location.latitude).toBeUndefined();
    expect(parsed.device.location.longitude).toBeUndefined();
  });

  it("returns fresh location data on premium when recent", async () => {
    // Set location with recent timestamp (30 seconds ago)
    const thirtySecsAgo = Date.now() / 1000 - 30;
    ctx.applySnapshot({ location: { latitude: 52.47, longitude: 13.43 } }, thirtySecsAgo);

    const tool = createGetContextTool(ctx);
    const result = await tool.execute("test", {});
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.device.location.stale).toBeUndefined();
    expect(parsed.device.location.latitude).toBe(52.47);
    expect(parsed.device.location.longitude).toBe(13.43);
    expect(parsed.device.location.dataAgeSeconds).toBeLessThan(60);
  });

  it("uses different thresholds per field (health = 60 min)", async () => {
    // Set health with 20-minute-old timestamp — should NOT be stale (threshold is 60 min)
    const twentyMinsAgo = Date.now() / 1000 - 1200;
    ctx.applySnapshot({ health: { stepsToday: 5000 } }, twentyMinsAgo);

    const tool = createGetContextTool(ctx);
    const result = await tool.execute("test", {});
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.device.health.stale).toBeUndefined();
    expect(parsed.device.health.stepsToday).toBe(5000);
  });

  it("always returns full data on free tier regardless of age", async () => {
    ctx.setRuntimeState({ tier: "free", smartMode: false });
    const twoHoursAgo = Date.now() / 1000 - 7200;
    ctx.applySnapshot({ location: { latitude: 52.47, longitude: 13.43 } }, twoHoursAgo);

    const tool = createGetContextTool(ctx);
    const result = await tool.execute("test", {});
    const parsed = JSON.parse(result.content[0].text);

    // Free tier always gets values
    expect(parsed.device.location.latitude).toBe(52.47);
    expect(parsed.device.location.stale).toBeUndefined();
  });

  it("treats null age as stale on premium", async () => {
    // Manually set location without a timestamp
    ctx.applySnapshot({ location: { latitude: 52.47, longitude: 13.43 } });
    // Hack: clear the timestamp to simulate missing data
    (ctx as any).timestamps = {};

    const tool = createGetContextTool(ctx);
    const result = await tool.execute("test", {});
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.device.location.stale).toBe(true);
    expect(parsed.device.location.ageHuman).toBe("unknown");
    expect(parsed.device.location.freshCommand).toBe("location.get");
  });
});
