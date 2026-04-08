import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { EventLogEntry, PluginModuleLogger, TriageProfile, ReactionEntry } from "./types.js";
import type { EventLog } from "./events.js";
import type { ContextManager } from "./context.js";
import type { ReactionTracker } from "./reactions.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

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
  previousProfile: TriageProfile | null;
  patternsJson: string;
}

export function buildLearnerPrompt(input: LearnerInput): string {
  const { memorySummary, recentEvents, reactions, previousProfile, patternsJson } = input;

  const memorySection = memorySummary
    ? `## Today's Activity (from agent memory)\n\n${memorySummary}`
    : "## Today's Activity\nNo memory summary available for today.";

  const eventsSection = recentEvents.length > 0
    ? `## Recent Events (last 24h)\n\n${recentEvents
        .map((e) => `- [${e.decision}] ${e.event.source} (${e.event.subscriptionId}): ${e.reason}`)
        .join("\n")}`
    : "## Recent Events\nNo events in the last 24 hours.";

  const reactionsSection = reactions.length > 0
    ? `## Notification Reactions\n\n${reactions
        .map((r) => `- ${r.source} (${r.subscriptionId}): ${r.status}`)
        .join("\n")}`
    : "## Notification Reactions\nNo push reaction data available.";

  const prevSection = previousProfile
    ? `## Previous Triage Profile\n\nSummary: ${previousProfile.summary}\nInterruption tolerance: ${previousProfile.interruptionTolerance}`
    : "## Previous Triage Profile\nNo previous profile — this is the first analysis.";

  return `You are analyzing a user's device event patterns and daily activity to build a personalized notification triage profile.

${memorySection}

${eventsSection}

${reactionsSection}

## Computed Patterns
${patternsJson}

${prevSection}

Based on all of the above, produce an updated triage profile as JSON with these fields:
- summary: string — 1-2 sentence human-readable summary of this user's preferences
- interruptionTolerance: "low"|"normal"|"high"

Respond with ONLY the JSON object, no markdown fences.`;
}

export function parseTriageProfile(text: string): TriageProfile | null {
  try {
    const cleaned = text.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    if (!parsed.summary || !parsed.interruptionTolerance) return null;
    const validTolerances = ["low", "normal", "high"];
    return {
      summary: parsed.summary,
      interruptionTolerance: validTolerances.includes(parsed.interruptionTolerance)
        ? parsed.interruptionTolerance
        : "normal",
      computedAt: parsed.computedAt ?? Date.now() / 1000,
    };
  } catch {
    return null;
  }
}

export async function loadTriageProfile(stateDir: string): Promise<TriageProfile | null> {
  try {
    const content = await fs.readFile(path.join(stateDir, "triage-profile.json"), "utf-8");
    return parseTriageProfile(content);
  } catch {
    return null;
  }
}

const noopLogger: PluginModuleLogger = { info: () => {}, warn: () => {}, error: () => {} };

export async function saveTriageProfile(stateDir: string, profile: TriageProfile, logger?: PluginModuleLogger): Promise<boolean> {
  try {
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(path.join(stateDir, "triage-profile.json"), JSON.stringify(profile, null, 2), "utf-8");
    return true;
  } catch (err) {
    (logger ?? noopLogger).error(`triage profile save failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export interface RunLearnerDeps {
  stateDir: string;
  workspaceDir: string;
  context: ContextManager;
  events: EventLog;
  reactions: ReactionTracker;
  api: OpenClawPluginApi;
}

export async function runLearner(deps: RunLearnerDeps): Promise<void> {
  const { stateDir, workspaceDir, context, events, reactions, api } = deps;

  // 1. Read yesterday's memory summary (learner runs at 5am, today's barely exists)
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const memorySummary = await readMemorySummary(workspaceDir, yesterday)
    ?? await readMemorySummary(workspaceDir, new Date());

  // 2. Read last 24h events
  const recentEvents = await events.readSince(Date.now() / 1000 - 86400);

  // 3. Get recent reactions
  const recentReactions = reactions.getRecent(24);

  // 4. Load previous profile
  const previousProfile = await loadTriageProfile(stateDir);

  // 5. Read patterns for context
  const patterns = await context.readPatterns();
  const patternsJson = JSON.stringify(patterns ?? {});

  // 6. Build prompt (include JSON-only instruction since extraSystemPrompt is not a valid SDK param)
  const prompt = buildLearnerPrompt({
    memorySummary,
    recentEvents,
    reactions: recentReactions,
    previousProfile,
    patternsJson,
  }) + "\n\nIMPORTANT: Respond with ONLY a JSON triage profile object. Do NOT call any tools.";

  // 7. Clean up any stale session from previous failed run
  try { await api.runtime.subagent.deleteSession({ sessionKey: "betterclaw-learn" }); } catch { /* ignore */ }

  // 8. Run subagent with try/finally for session cleanup
  let newProfile: TriageProfile | null = null;
  try {
    const { runId } = await api.runtime.subagent.run({
      sessionKey: "betterclaw-learn",
      message: prompt,
      deliver: false,
      idempotencyKey: `betterclaw-learn-${Date.now()}`,
    });

    // 9. Wait for completion
    await api.runtime.subagent.waitForRun({ runId, timeoutMs: 60000 });

    // 10. Read response
    const { messages } = await api.runtime.subagent.getSessionMessages({
      sessionKey: "betterclaw-learn",
      limit: 5,
    });

    // 11. Parse last assistant message — handle both string and content-block formats
    const lastAssistant = (messages as any[]).filter((m) => m.role === "assistant").pop();
    if (lastAssistant) {
      const content = typeof lastAssistant.content === "string"
        ? lastAssistant.content
        : Array.isArray(lastAssistant.content)
          ? lastAssistant.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("")
          : null;
      if (content) {
        newProfile = parseTriageProfile(content);
      }
    }
  } finally {
    // 12. Always delete session
    try { await api.runtime.subagent.deleteSession({ sessionKey: "betterclaw-learn" }); } catch { /* ignore */ }
  }

  // 13. Save if valid
  if (newProfile) {
    await saveTriageProfile(stateDir, newProfile, api.logger);
  }

  // 14. Rotate old reactions
  reactions.rotate();
  await reactions.save();
}
