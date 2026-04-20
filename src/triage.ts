import type { DeviceEvent } from "./types.js";
import type { ContextManager } from "./context.js";
import type { Rule, AuditEntry, RoutingAction } from "./routing/types.js";
import { errorFields } from "./errors.js";
import { dlog } from "./diagnostic-logger.js";

export interface TriageResult {
  action: RoutingAction;
  reason: string;
  priority?: "low" | "normal" | "high";
}

export function buildTriagePrompt(
  event: DeviceEvent,
  context: ContextManager,
  matchedNonExplicitRules: Rule[],
  lockedKeys: Set<string>,
  recentUserEdits: AuditEntry[],
  quietHours: { start: string; end: string; tz: string },
  currentLocalTime: string,
  budget?: { budgetUsed: number; budgetTotal: number },
): string {
  const ctx = context.get();
  const location = ctx.device.location;
  const activity = ctx.activity;

  const rulesSection = matchedNonExplicitRules.length > 0
    ? `## Matching Non-Explicit Rules (user's defaults for this kind of event)
${matchedNonExplicitRules.map(r => `- ${JSON.stringify(r)}`).join("\n")}

Field semantics:
- action="notify" → the user wants a Telegram message for this kind of event.
- action="push" → the user wants it injected silently into session context (agent sees it, user doesn't).
- action="drop" → the user wants this ignored entirely.
- respectQuietHours=true (or omitted) → during quiet hours, demote notify→push automatically.
- respectQuietHours=false → the user EXPLICITLY decided this rule should notify during quiet hours too. Do NOT second-guess this.`
    : "## Matching Non-Explicit Rules\nNone — use general judgement.";

  const userEditsSection = recentUserEdits.length > 0
    ? `## Recent User-Driven Edits (last 3 days — direct statements of intent)
These are edits the USER made themselves. Treat them as the ground truth. The "from → to" direction tells you what they changed INTO — that's what they want now.
${recentUserEdits.map(e => e.diffs.map(d => `- ${d.path}: ${JSON.stringify(d.from)} → ${JSON.stringify(d.to)}`).join("\n")).join("\n")}`
    : "## Recent User-Driven Edits\nNone.";

  const lockedSection = lockedKeys.size > 0
    ? `## User-Locked Keys (authoritative — user set these deliberately)
${Array.from(lockedKeys).join(", ")}

These paths were touched by the user within the last 14 days. Their current values ARE the user's preference. Don't interpret "locked" as "user wants quiet" — it means "user has an opinion here and we respect it." Look at the actual field value in the rule above to know which direction they chose.`
    : "";

  const quietSection = `## Quiet Hours (default, not a hard rule)
${quietHours.start}–${quietHours.end} (${quietHours.tz}). Current local time: ${currentLocalTime}.
Quiet hours are a soft default. If a rule has \`respectQuietHours: false\`, the user already decided this event type OVERRIDES quiet hours — notify anyway.`;

  const contextSection = [
    `## Current Device Context`,
    location?.label ? `Location: ${location.label}` : null,
    activity?.currentZone ? `Zone: ${activity.currentZone}` : null,
  ].filter(Boolean).join("\n");

  const budgetSection = budget
    ? `## Push Budget\n${budget.budgetUsed} of ${budget.budgetTotal} pushes used today — be selective.`
    : "";

  return `You are an event triage system for a personal assistant. Decide whether this device event should be dropped, pushed silently into the agent's session context, or surfaced as a notification to the user.

${rulesSection}

${userEditsSection}

${lockedSection}

${quietSection}

${contextSection}
${budgetSection ? `\n${budgetSection}` : ""}

## Event
- Subscription: ${event.subscriptionId}
- Source: ${event.source}
- Data: ${JSON.stringify(event.data)}
- Fired at: ${new Date(event.firedAt * 1000).toISOString()}
${event.metadata ? `- Metadata: ${JSON.stringify(event.metadata)}` : ""}

Respond with JSON: {"action": "drop"|"push"|"notify", "reason": string, "priority"?: "low"|"normal"|"high"}

- "drop" — don't send anywhere.
- "push" — inject as silent session context only. Agent sees it but no user-facing message.
- "notify" — surface a user-facing message via the user's bound channel.`;
}

export function parseTriageResponse(text: string): TriageResult {
  try {
    const cleaned = text.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    const action: RoutingAction = ["drop", "push", "notify"].includes(parsed.action)
      ? parsed.action
      : "drop";
    return {
      action,
      reason: String(parsed.reason ?? "no reason"),
      priority: ["low", "normal", "high"].includes(parsed.priority) ? parsed.priority : undefined,
    };
  } catch {
    return { action: "drop", reason: "failed to parse triage response — defaulting to drop" };
  }
}

export async function triageEvent(
  event: DeviceEvent,
  context: ContextManager,
  matchedNonExplicitRules: Rule[],
  lockedKeys: Set<string>,
  recentUserEdits: AuditEntry[],
  quietHours: { start: string; end: string; tz: string },
  currentLocalTime: string,
  config: { triageModel: string; triageApiBase?: string; budgetUsed?: number; budgetTotal?: number },
  resolveApiKey: () => Promise<string | undefined>,
): Promise<TriageResult> {
  dlog.info("plugin.triage", "triage.called", "sending triage request", {
    subscriptionId: event.subscriptionId,
    model: config.triageModel,
  });

  const prompt = buildTriagePrompt(
    event, context, matchedNonExplicitRules, lockedKeys, recentUserEdits,
    quietHours, currentLocalTime,
    config.budgetUsed != null && config.budgetTotal != null
      ? { budgetUsed: config.budgetUsed, budgetTotal: config.budgetTotal }
      : undefined,
  );

  try {
    const apiKey = await resolveApiKey();
    if (!apiKey) return { action: "drop", reason: "no API key for triage — defaulting to drop" };

    const baseUrl = config.triageApiBase ?? "https://api.openai.com/v1";
    const model = config.triageModel.includes("/")
      ? config.triageModel.split("/").slice(1).join("/")
      : config.triageModel;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "triage_decision",
              strict: true,
              schema: {
                type: "object",
                properties: {
                  action: { type: "string", enum: ["drop", "push", "notify"] },
                  reason: { type: "string" },
                  priority: { type: "string", enum: ["low", "normal", "high"] },
                },
                required: ["action", "reason", "priority"],
                additionalProperties: false,
              },
            },
          },
          max_completion_tokens: 200,
        }),
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      dlog.warning("plugin.triage", "triage.http.error", "triage API non-ok",
        { status: response.status, body: body.slice(0, 500) });
      return { action: "drop", reason: `triage API error: ${response.status} — defaulting to drop` };
    }

    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return { action: "drop", reason: "empty triage response — defaulting to drop" };

    const result = parseTriageResponse(content);
    dlog.info("plugin.triage", "triage.result", "triage decision", {
      subscriptionId: event.subscriptionId,
      decision: result.action,
      reason: result.reason,
    });
    return result;
  } catch (err) {
    dlog.error("plugin.triage", "triage.fallback", "triage failed, falling back to drop", {
      subscriptionId: event.subscriptionId,
      fallbackAction: "drop",
      ...errorFields(err),
    });
    return { action: "drop", reason: `triage call failed: ${err} — defaulting to drop` };
  }
}
