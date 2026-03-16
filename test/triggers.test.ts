import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ContextManager } from "../src/context.js";
import { emptyPatterns } from "../src/patterns.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-triggers-"));
});

describe("ProactiveEngine", () => {
  it("empty context doesn't crash trigger checks", () => {
    const ctx = ContextManager.empty();
    const patterns = emptyPatterns();

    expect(ctx.device.battery).toBeNull();
    expect(patterns.healthTrends.stepsAvg7d).toBeNull();
    expect(patterns.triggerCooldowns).toEqual({});
  });

  it("trigger cooldowns are tracked in patterns", () => {
    const patterns = emptyPatterns();
    patterns.triggerCooldowns["low-battery-away"] = Date.now() / 1000;
    expect(patterns.triggerCooldowns["low-battery-away"]).toBeGreaterThan(0);
  });
});

describe("smartMode gating", () => {
  it("smartMode defaults to false in a fresh ContextManager", async () => {
    const ctx = new ContextManager(tmpDir);
    expect(ctx.getRuntimeState().smartMode).toBe(false);
  });

  it("smartMode can be enabled via setRuntimeState", async () => {
    const ctx = new ContextManager(tmpDir);
    ctx.setRuntimeState({ tier: "premium", smartMode: true });
    expect(ctx.getRuntimeState().smartMode).toBe(true);
  });

  it("smartMode can be disabled after being enabled", async () => {
    const ctx = new ContextManager(tmpDir);
    ctx.setRuntimeState({ tier: "premium", smartMode: true });
    ctx.setRuntimeState({ tier: "premium", smartMode: false });
    expect(ctx.getRuntimeState().smartMode).toBe(false);
  });
});
