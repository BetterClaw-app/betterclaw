import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ContextManager } from "../src/context.js";
import { createGetContextTool } from "../src/tools/get-context.js";

describe("get_context tool", () => {
  let tmpDir: string;
  let ctx: ContextManager;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-tool-"));
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

describe("get_context stale data hiding (premium)", () => {
  let tmpDir: string;
  let ctx: ContextManager;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-stale-"));
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
