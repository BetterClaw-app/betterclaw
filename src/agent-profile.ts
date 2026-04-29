import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

export const AGENT_PROFILE_START = "<!-- betterclaw-device-profile:start v1 -->";
export const AGENT_PROFILE_END = "<!-- betterclaw-device-profile:end -->";

const STATE_FILE = "agent-profile.json";

export type BetterClawTier = "free" | "premium" | null;

export type AgentProfileState = {
  enabled: boolean;
  workspaceDir: string | null;
  toolsFile: string | null;
  lastActiveNodeId: string | null;
  lastTier: BetterClawTier;
  lastFactsKey: string | null;
  lastSyncAt: string | null;
};

export type RenderProfileInput = {
  updatedAt: string;
  tier: BetterClawTier;
  activeNodeId: string | null;
};

export type SyncProfileInput = {
  tier: BetterClawTier;
  activeNodeId?: string | null;
  now?: Date;
};

export function defaultAgentProfileState(): AgentProfileState {
  return {
    enabled: false,
    workspaceDir: null,
    toolsFile: null,
    lastActiveNodeId: null,
    lastTier: null,
    lastFactsKey: null,
    lastSyncAt: null,
  };
}

function dataPathFor(tier: BetterClawTier): string {
  if (tier === "premium") return "use BetterClaw node commands for fresh device readings.";
  if (tier === "free") return "use `get_context` for device data from the foreground/cached path.";
  return "tier unknown; call `check_tier` once BetterClaw is connected, then follow the returned dataPath.";
}

function profileFactsKey(input: { tier: BetterClawTier; activeNodeId: string | null }): string {
  return JSON.stringify({
    version: 1,
    tier: input.tier ?? "unknown",
    activeNodeId: input.activeNodeId ?? "unknown",
    dataPath: dataPathFor(input.tier),
  });
}

function findLastCompleteGeneratedBlock(text: string): { start: number; afterEnd: number } | null {
  const start = text.lastIndexOf(AGENT_PROFILE_START);
  if (start < 0) return null;

  const end = text.indexOf(AGENT_PROFILE_END, start + AGENT_PROFILE_START.length);
  if (end <= start) return null;

  return { start, afterEnd: end + AGENT_PROFILE_END.length };
}

function hasCompleteGeneratedBlock(text: string): boolean {
  return findLastCompleteGeneratedBlock(text) !== null;
}

function oneLine(value: string): string {
  return value
    .replaceAll(AGENT_PROFILE_START, "")
    .replaceAll(AGENT_PROFILE_END, "")
    .replace(/[\r\n]/g, " ")
    .trim();
}

export function renderAgentProfileBlock(input: RenderProfileInput): string {
  const tier = input.tier ?? "unknown";
  const activeNode = input.activeNodeId ? oneLine(input.activeNodeId) || "unknown" : "unknown";
  return `${AGENT_PROFILE_START}
### BetterClaw Device Profile

Updated: ${input.updatedAt}
Tier: ${tier}
Active node: ${activeNode}
Data path: ${dataPathFor(input.tier)}

Fast paths:
- Current location: call \`location.get\` on the active BetterClaw node when Tier is premium.
- Location-related requests like "where am I?", "what city am I in?", "am I near home?", or "how far am I from work?": call \`location.get\` first when Tier is premium.
- Health requests: call the matching \`health.*\` command directly when Tier is premium.
- Shortcut inventory: call \`shortcuts.registry.get\`.
- Running shortcuts: use exact names from the registry with \`shortcuts.run\`.

Free-tier behavior:
- Use \`get_context\` for device data instead of node commands.
- Check timestamps and mention when location or health data may be stale.

This block is maintained automatically by the BetterClaw plugin.
${AGENT_PROFILE_END}`;
}

export function replaceGeneratedBlock(original: string, generatedBlock: string): string {
  const block = findLastCompleteGeneratedBlock(original);
  if (block) {
    return `${original.slice(0, block.start)}${generatedBlock}${original.slice(block.afterEnd).replace(/^\n?/, "\n")}`;
  }
  const separator = original.endsWith("\n") ? "\n" : "\n\n";
  return `${original}${separator}${generatedBlock}\n`;
}

export function removeGeneratedBlock(original: string): string {
  const block = findLastCompleteGeneratedBlock(original);
  if (!block) return original;
  return `${original.slice(0, block.start).replace(/\n{2,}$/, "\n")}${original.slice(block.afterEnd).replace(/^\n?/, "")}`;
}

async function readTextIfExists(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function writeFileAtomic(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmpPath = `${file}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
  await fs.writeFile(tmpPath, content, "utf8");
  await fs.rename(tmpPath, file);
}

export class AgentProfileManager {
  private statePath: string;

  constructor(private readonly stateDir: string) {
    this.statePath = path.join(stateDir, STATE_FILE);
  }

  async loadState(): Promise<AgentProfileState> {
    try {
      const raw = await fs.readFile(this.statePath, "utf8");
      return { ...defaultAgentProfileState(), ...JSON.parse(raw) } as AgentProfileState;
    } catch {
      return defaultAgentProfileState();
    }
  }

  async saveState(state: AgentProfileState): Promise<void> {
    await fs.mkdir(this.stateDir, { recursive: true });
    await writeFileAtomic(this.statePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  async configure(input: { enabled: boolean; workspaceDir: string }): Promise<AgentProfileState> {
    const existing = await this.loadState();
    const toolsFile = path.join(input.workspaceDir, "TOOLS.md");
    const next = { ...existing, enabled: input.enabled, workspaceDir: input.workspaceDir, toolsFile };

    if (!input.enabled) {
      const original = await readTextIfExists(toolsFile);
      if (original !== null) {
        const cleaned = removeGeneratedBlock(original);
        if (cleaned !== original) await writeFileAtomic(toolsFile, cleaned);
      }
    }

    await this.saveState(next);
    return next;
  }

  async sync(input: SyncProfileInput): Promise<{ changed: boolean; reason: string }> {
    const state = await this.loadState();
    if (!state.enabled) return { changed: false, reason: "disabled" };

    const workspaceDir = state.workspaceDir ?? path.join(process.env.HOME ?? "", ".openclaw", "workspace");
    const toolsFile = state.toolsFile ?? path.join(workspaceDir, "TOOLS.md");
    const hasActiveNodeInput = Object.prototype.hasOwnProperty.call(input, "activeNodeId");
    const activeNodeId = hasActiveNodeInput ? input.activeNodeId ?? null : state.lastActiveNodeId;
    const tier = input.tier ?? state.lastTier;

    await fs.mkdir(workspaceDir, { recursive: true });
    const original = await readTextIfExists(toolsFile) ?? "# TOOLS.md - Local Notes\n";
    const factsKey = profileFactsKey({ tier, activeNodeId: activeNodeId ?? null });
    const factsChanged = factsKey !== state.lastFactsKey;
    const lastSyncAt = state.lastSyncAt;
    const shouldRefreshTimestamp = factsChanged || !hasCompleteGeneratedBlock(original) || !lastSyncAt;
    const updatedAt = shouldRefreshTimestamp ? (input.now ?? new Date()).toISOString() : lastSyncAt;
    const generated = renderAgentProfileBlock({ updatedAt, tier, activeNodeId });
    const next = replaceGeneratedBlock(original, generated);

    const nextState = {
      ...state,
      workspaceDir,
      toolsFile,
      lastActiveNodeId: activeNodeId ?? null,
      lastTier: tier,
      lastFactsKey: factsKey,
      lastSyncAt: updatedAt,
    };

    if (next === original) {
      if (factsChanged || nextState.lastSyncAt !== state.lastSyncAt) {
        await this.saveState(nextState);
        return { changed: false, reason: "state-updated" };
      }
      return { changed: false, reason: "unchanged" };
    }

    await writeFileAtomic(toolsFile, next);
    await this.saveState(nextState);
    return { changed: true, reason: "updated" };
  }
}
