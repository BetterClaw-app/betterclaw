import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { EventLogEntry, TriageProfile, ReactionEntry } from "./types.js";
import type { EventLog } from "./events.js";
import type { ContextManager } from "./context.js";
import type { ReactionTracker } from "./reactions.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

export async function readMemorySummary(workspaceDir: string, date: Date): Promise<string | null> {
  const dateStr = date.toISOString().split("T")[0];
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
        .map((r) => {
          const status = r.engaged === true ? "engaged" : r.engaged === false ? "ignored" : "unknown";
          return `- ${r.source} (${r.subscriptionId}): ${status}`;
        })
        .join("\n")}`
    : "## Notification Reactions\nNo push reaction data available.";

  const prevSection = previousProfile
    ? `## Previous Triage Profile\n\nSummary: ${previousProfile.summary}\nLife context: ${previousProfile.lifeContext}\nInterruption tolerance: ${previousProfile.interruptionTolerance}`
    : "## Previous Triage Profile\nNo previous profile — this is the first analysis.";

  return `You are analyzing a user's device event patterns and daily activity to build a personalized notification triage profile.

${memorySection}

${eventsSection}

${reactionsSection}

## Computed Patterns
${patternsJson}

${prevSection}

Based on all of the above, produce an updated triage profile as JSON with these fields:
- eventPreferences: Record<string, "push"|"drop"|"context-dependent"> — per event source
- lifeContext: string — brief description of user's current life situation
- interruptionTolerance: "low"|"normal"|"high"
- timePreferences: { quietHoursStart?, quietHoursEnd?, activeStart?, activeEnd? } — hours (0-23)
- sensitivityThresholds: Record<string, number> — e.g. batteryLevel: 0.15
- locationRules: Record<string, "push"|"drop"|"context-dependent"> — per zone name
- summary: string — 1-2 sentence human-readable summary of this user's preferences

Respond with ONLY the JSON object, no markdown fences.`;
}

export function parseTriageProfile(text: string): TriageProfile | null {
  try {
    const cleaned = text.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    if (!parsed.summary || !parsed.interruptionTolerance) return null;
    return {
      eventPreferences: parsed.eventPreferences ?? {},
      lifeContext: parsed.lifeContext ?? "",
      interruptionTolerance: parsed.interruptionTolerance,
      timePreferences: parsed.timePreferences ?? {},
      sensitivityThresholds: parsed.sensitivityThresholds ?? {},
      locationRules: parsed.locationRules ?? {},
      summary: parsed.summary,
      computedAt: Date.now() / 1000,
    };
  } catch {
    return null;
  }
}

export async function loadTriageProfile(stateDir: string): Promise<TriageProfile | null> {
  try {
    const content = await fs.readFile(path.join(stateDir, "triage-profile.json"), "utf-8");
    return JSON.parse(content) as TriageProfile;
  } catch {
    return null;
  }
}

export async function saveTriageProfile(stateDir: string, profile: TriageProfile): Promise<void> {
  await fs.writeFile(path.join(stateDir, "triage-profile.json"), JSON.stringify(profile, null, 2), "utf-8");
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

  // 1. Read memory summary
  const memorySummary = await readMemorySummary(workspaceDir, new Date());

  // 2. Read last 24h events
  const recentEvents = await events.readSince(Date.now() / 1000 - 86400);

  // 3. Get recent reactions
  const recentReactions = reactions.getRecent(24);

  // 4. Load previous profile
  const previousProfile = await loadTriageProfile(stateDir);

  // 5. Read patterns for context
  const patterns = await context.readPatterns();
  const patternsJson = JSON.stringify(patterns ?? {});

  // 6. Build prompt
  const prompt = buildLearnerPrompt({
    memorySummary,
    recentEvents,
    reactions: recentReactions,
    previousProfile,
    patternsJson,
  });

  // 7. Run subagent
  const { runId } = await api.runtime.subagent.run({
    sessionKey: "betterclaw-learn",
    message: prompt,
    deliver: false,
    extraSystemPrompt: "Respond with ONLY a JSON triage profile. Do NOT call any tools.",
  });

  // 8. Wait for completion
  await api.runtime.subagent.waitForRun({ runId, timeoutMs: 60000 });

  // 9. Read response
  const messages = await api.runtime.subagent.getSessionMessages({
    sessionKey: "betterclaw-learn",
    limit: 5,
  });

  // 10. Parse last assistant message
  const lastAssistant = messages.filter((m: any) => m.role === "assistant").pop();
  const newProfile = lastAssistant ? parseTriageProfile(lastAssistant.content) : null;

  // 11. Save if valid, otherwise keep previous
  if (newProfile) {
    await saveTriageProfile(stateDir, newProfile);
  }

  // 12. Delete session
  await api.runtime.subagent.deleteSession({ sessionKey: "betterclaw-learn" });

  // 13. Rotate old reactions
  reactions.rotate();
  await reactions.save();
}
