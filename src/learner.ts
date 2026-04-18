import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { EventLogEntry, ReactionEntry } from "./types.js";
import type { EventLog } from "./events.js";
import type { ContextManager } from "./context.js";
import type { ReactionTracker } from "./reactions.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { RoutingRules, AuditEntry, JsonPatchOp } from "./routing/types.js";
import type { RoutingConfigStore } from "./routing/config-store.js";
import type { AuditLog } from "./routing/audit-log.js";
import { computeLockedKeys } from "./routing/audit-log.js";
import { dlog } from "./diagnostic-logger.js";

export async function readMemorySummary(workspaceDir: string, date: Date): Promise<string | null> {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const dateStr = `${y}-${m}-${d}`;
  const memoryPath = path.join(workspaceDir, "memory", `${dateStr}.md`);
  try {
    return await fs.readFile(memoryPath, "utf-8");
  } catch {
    return null;
  }
}

export interface LearnerInput {
  memorySummary: string | null;
  recentEvents: EventLogEntry[];
  reactions: ReactionEntry[];
  patternsJson: string;
  currentRules: RoutingRules;
  recentAudit: AuditEntry[];
  lockedKeys: Set<string>;
}

export interface LearnerOutput {
  patchOps: JsonPatchOp[];
  reason: string;
}

export function buildLearnerPrompt(input: LearnerInput): string {
  const { memorySummary, recentEvents, reactions, patternsJson, currentRules, recentAudit, lockedKeys } = input;

  const memorySection = memorySummary
    ? `## Today's Activity (from agent memory)\n\n${memorySummary}`
    : "## Today's Activity\nNo memory summary available for today.";

  const eventsSection = recentEvents.length > 0
    ? `## Recent Events (last 24h)\n\n${recentEvents.map(e => `- [${e.decision}] ${e.event.source} (${e.event.subscriptionId}): ${e.reason}`).join("\n")}`
    : "## Recent Events\nNo events in the last 24 hours.";

  const reactionsSection = reactions.length > 0
    ? `## Notification Reactions\n\n${reactions.map(r => `- ${r.source} (${r.subscriptionId}): ${r.status}`).join("\n")}`
    : "## Notification Reactions\nNo reaction data available yet.";

  const rulesSection = `## Current Routing Rules\n${JSON.stringify(currentRules, null, 2)}`;

  const auditSection = recentAudit.length > 0
    ? `## Recent Audit (last 30 days)\n${recentAudit.map(e => `- ts=${e.ts} source=${e.source} ${e.reason ?? ""} diffs=${JSON.stringify(e.diffs)}`).join("\n")}`
    : "## Recent Audit\nNo recent changes.";

  const lockedSection = lockedKeys.size > 0
    ? `## Locked Keys\nThe user has manually edited these paths recently. DO NOT modify them:\n${Array.from(lockedKeys).join("\n")}`
    : "## Locked Keys\nNone.";

  return `You are tuning a user's event-notification routing rules based on their recent reactions and device activity.

${memorySection}

${eventsSection}

${reactionsSection}

## Computed Patterns
${patternsJson}

${rulesSection}

${auditSection}

${lockedSection}

Propose JSON Patch operations to improve signal-to-noise given the reactions. Patch operations targeting locked keys WILL be dropped. If no change is warranted, return an empty patchOps array.

Respond with JSON: {"patchOps": <array of RFC 6902 ops>, "reason": <one-sentence explanation>}`;
}

export function parseLearnerOutput(text: string): LearnerOutput {
  try {
    const cleaned = text.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    const patchOps = Array.isArray(parsed.patchOps) ? parsed.patchOps : [];
    return { patchOps, reason: String(parsed.reason ?? "no reason") };
  } catch {
    return { patchOps: [], reason: "failed to parse learner output" };
  }
}

export interface RunLearnerDeps {
  stateDir: string;
  workspaceDir: string;
  context: ContextManager;
  events: EventLog;
  reactions: ReactionTracker;
  api: OpenClawPluginApi;
  routing: RoutingConfigStore;
  audit: AuditLog;
}

export async function runLearner(deps: RunLearnerDeps): Promise<void> {
  const { stateDir, workspaceDir, context, events, reactions, api, routing, audit } = deps;
  void stateDir;

  // 1. Memory summary
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const memorySummary = await readMemorySummary(workspaceDir, yesterday)
    ?? await readMemorySummary(workspaceDir, new Date());

  // 2. Recent events
  const recentEvents = await events.readSince(Date.now() / 1000 - 86400);

  // 3. Reactions
  const recentReactions = reactions.getRecent(24);

  // 4. Patterns (preserve existing wiring — do NOT replace with "{}")
  const patterns = await context.readPatterns();
  const patternsJson = JSON.stringify(patterns ?? {});

  // 5. Routing config + audit context
  const now = Math.floor(Date.now() / 1000);
  const recentAudit = await audit.readSince(now - 30 * 86400);
  const lockedKeys = computeLockedKeys(recentAudit, now, 14 * 86400);
  const currentRules = routing.getRules();

  dlog.info("plugin.learner", "learner.started", "daily learner run started", {
    eventsCount: recentEvents.length,
    reactionsCount: recentReactions.length,
    hasMemory: memorySummary !== null,
    lockedKeysCount: lockedKeys.size,
  });

  // 6. Build prompt
  const prompt = buildLearnerPrompt({
    memorySummary,
    recentEvents,
    reactions: recentReactions,
    patternsJson,
    currentRules,
    recentAudit,
    lockedKeys,
  }) + "\n\nIMPORTANT: Respond with ONLY a JSON object { patchOps, reason }. Do NOT call any tools.";

  // 7. Clean up stale session
  try { await api.runtime.subagent.deleteSession({ sessionKey: "betterclaw-learn" }); } catch { /* ignore */ }

  // 8. Run subagent (same pattern as before)
  let content: string | null = null;
  try {
    const { runId } = await api.runtime.subagent.run({
      sessionKey: "betterclaw-learn",
      message: prompt,
      deliver: false,
      idempotencyKey: `betterclaw-learn-${Date.now()}`,
    });
    await api.runtime.subagent.waitForRun({ runId, timeoutMs: 60000 });
    const { messages } = await api.runtime.subagent.getSessionMessages({
      sessionKey: "betterclaw-learn",
      limit: 5,
    });
    const lastAssistant = (messages as any[]).filter((m) => m.role === "assistant").pop();
    if (lastAssistant) {
      content = typeof lastAssistant.content === "string"
        ? lastAssistant.content
        : Array.isArray(lastAssistant.content)
          ? lastAssistant.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("")
          : null;
    }
  } finally {
    try { await api.runtime.subagent.deleteSession({ sessionKey: "betterclaw-learn" }); } catch { /* ignore */ }
  }

  // 9. Parse + apply patch
  if (content) {
    const output = parseLearnerOutput(content);
    if (output.patchOps.length > 0) {
      const result = await routing.applyPatch(output.patchOps, "learner", output.reason);
      dlog.info("plugin.learner", "profile.updated", "routing rules updated via learner", {
        applied: result.applied.length,
        dropped: result.dropped.length,
      });
    } else {
      dlog.info("plugin.learner", "profile.updated", "learner proposed no changes", { reason: output.reason });
    }
  } else {
    dlog.warning("plugin.learner", "parse.failed", "no assistant content from learner run", {});
  }

  // 10. Rotate reactions (unchanged)
  reactions.rotate();
  await reactions.save();
}
