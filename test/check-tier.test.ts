import { describe, it, expect } from "vitest";
import { createCheckTierTool } from "../src/tools/check-tier.js";
import { ContextManager } from "../src/context.js";

function makeCtx(tier: "free" | "premium" | "premium+" | null): ContextManager {
  const ctx = new ContextManager("/tmp/test-check-tier");
  if (tier) {
    ctx.setRuntimeState({ tier, smartMode: tier !== "free" });
  }
  return ctx;
}

describe("check_tier tool", () => {
  const defaultState = () => ({ pingReceived: true, calibrating: false });

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

  it("returns unknown tier with short TTL when no ping received", async () => {
    const ctx = new ContextManager("/tmp/test-check-tier-unknown");
    const tool = createCheckTierTool(ctx, () => ({ pingReceived: false, calibrating: false }));
    const result = await tool.execute("test-id", {});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.tier).toBe("unknown");
    expect(parsed.cacheUntil - Date.now() / 1000).toBeLessThan(120);
  });

  it("includes calibrating flag when system is calibrating", async () => {
    const endsAt = Date.now() / 1000 + 86400 * 2;
    const tool = createCheckTierTool(makeCtx("premium"), () => ({
      pingReceived: true,
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
