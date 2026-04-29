import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_PROFILE_END,
  AGENT_PROFILE_START,
  AgentProfileManager,
  defaultAgentProfileState,
  renderAgentProfileBlock,
  replaceGeneratedBlock,
} from "../src/agent-profile.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bc-profile-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("renderAgentProfileBlock", () => {
  it("renders premium fast paths with active node id and location examples", () => {
    const block = renderAgentProfileBlock({
      updatedAt: "2026-04-29T12:00:00.000Z",
      tier: "premium",
      activeNodeId: "betterclaw-ios-abc123",
    });

    expect(block).toContain(AGENT_PROFILE_START);
    expect(block).toContain("Tier: premium");
    expect(block).toContain("Active node: betterclaw-ios-abc123");
    expect(block).toContain("call `location.get` on the active BetterClaw node");
    expect(block).toContain('"where am I?"');
    expect(block).toContain("`shortcuts.registry.get`");
    expect(block).toContain(AGENT_PROFILE_END);
  });

  it("renders free tier as get_context first", () => {
    const block = renderAgentProfileBlock({
      updatedAt: "2026-04-29T12:00:00.000Z",
      tier: "free",
      activeNodeId: null,
    });

    expect(block).toContain("Tier: free");
    expect(block).toContain("Active node: unknown");
    expect(block).toContain("Data path: use `get_context` for device data");
    expect(block).toContain("Use `get_context` for device data instead of node commands");
  });
});

describe("replaceGeneratedBlock", () => {
  const generated = `${AGENT_PROFILE_START}\n### BetterClaw Device Profile\nnew\n${AGENT_PROFILE_END}`;

  it("appends a block when no markers exist", () => {
    expect(replaceGeneratedBlock("# TOOLS.md\n", generated)).toBe(`# TOOLS.md\n\n${generated}\n`);
  });

  it("replaces only the marked range", () => {
    const original = `before\n${AGENT_PROFILE_START}\nold\n${AGENT_PROFILE_END}\nafter\n`;
    expect(replaceGeneratedBlock(original, generated)).toBe(`before\n${generated}\nafter\n`);
  });

  it("appends a fresh block when markers are malformed", () => {
    const original = `before\n${AGENT_PROFILE_START}\nold\n`;
    expect(replaceGeneratedBlock(original, generated)).toBe(`before\n${AGENT_PROFILE_START}\nold\n\n${generated}\n`);
  });

  it("replaces the last complete block without deleting an older malformed marker", () => {
    const original = `before\n${AGENT_PROFILE_START}\nold user text\n\n${generated}\nafter\n`;
    const next = `${AGENT_PROFILE_START}\n### BetterClaw Device Profile\nnewer\n${AGENT_PROFILE_END}`;

    expect(replaceGeneratedBlock(original, next)).toBe(`before\n${AGENT_PROFILE_START}\nold user text\n\n${next}\nafter\n`);
  });
});

describe("AgentProfileManager", () => {
  it("creates TOOLS.md and skips unchanged writes without timestamp churn", async () => {
    const workspace = path.join(tmpDir, "workspace");
    const manager = new AgentProfileManager(tmpDir);
    await manager.saveState({ ...defaultAgentProfileState(), enabled: true, workspaceDir: workspace });

    const first = await manager.sync({ tier: "premium", activeNodeId: "node-a", now: new Date("2026-04-29T12:00:00.000Z") });
    const second = await manager.sync({ tier: "premium", activeNodeId: "node-a", now: new Date("2026-05-06T12:00:00.000Z") });

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);

    const tools = await fs.readFile(path.join(workspace, "TOOLS.md"), "utf8");
    expect(tools).toContain("Active node: node-a");
    expect(tools).toContain("Updated: 2026-04-29T12:00:00.000Z");
    expect(tools).not.toContain("Updated: 2026-05-06T12:00:00.000Z");
  });

  it("updates when the active node id changes", async () => {
    const workspace = path.join(tmpDir, "workspace");
    const manager = new AgentProfileManager(tmpDir);
    await manager.saveState({ ...defaultAgentProfileState(), enabled: true, workspaceDir: workspace });

    await manager.sync({ tier: "premium", activeNodeId: "node-a", now: new Date("2026-04-29T12:00:00.000Z") });
    const result = await manager.sync({ tier: "premium", activeNodeId: "node-b", now: new Date("2026-05-06T12:00:00.000Z") });

    expect(result.changed).toBe(true);
    const tools = await fs.readFile(path.join(workspace, "TOOLS.md"), "utf8");
    expect(tools).toContain("Active node: node-b");
    expect(tools).toContain("Updated: 2026-05-06T12:00:00.000Z");
  });

  it("clears the active node id when sync is explicitly given null", async () => {
    const workspace = path.join(tmpDir, "workspace");
    const manager = new AgentProfileManager(tmpDir);
    await manager.saveState({ ...defaultAgentProfileState(), enabled: true, workspaceDir: workspace });

    await manager.sync({ tier: "premium", activeNodeId: "node-a", now: new Date("2026-04-29T12:00:00.000Z") });
    await manager.sync({ tier: "premium", activeNodeId: null, now: new Date("2026-05-06T12:00:00.000Z") });

    const tools = await fs.readFile(path.join(workspace, "TOOLS.md"), "utf8");
    expect(tools).toContain("Active node: unknown");
    expect(tools).not.toContain("Active node: node-a");
  });

  it("removes the generated block when profile maintenance is disabled", async () => {
    const workspace = path.join(tmpDir, "workspace");
    const manager = new AgentProfileManager(tmpDir);
    await manager.configure({ enabled: true, workspaceDir: workspace });
    await manager.sync({ tier: "premium", activeNodeId: "node-a", now: new Date("2026-04-29T12:00:00.000Z") });

    await manager.configure({ enabled: false, workspaceDir: workspace });

    const tools = await fs.readFile(path.join(workspace, "TOOLS.md"), "utf8");
    expect(tools).not.toContain(AGENT_PROFILE_START);
    expect(tools).not.toContain(AGENT_PROFILE_END);
  });

  it("does nothing when disabled", async () => {
    const manager = new AgentProfileManager(tmpDir);
    await manager.saveState({ ...defaultAgentProfileState(), enabled: false, workspaceDir: path.join(tmpDir, "workspace") });

    const result = await manager.sync({ tier: "premium", activeNodeId: "node-a", now: new Date("2026-04-29T12:00:00.000Z") });

    expect(result.changed).toBe(false);
    expect(result.reason).toBe("disabled");
  });
});
