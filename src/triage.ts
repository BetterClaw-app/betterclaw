import type { DeviceEvent, TriageProfile } from "./types.js";
import type { ContextManager } from "./context.js";
import { errorFields } from "./errors.js";
import { dlog } from "./diagnostic-logger.js";

export interface TriageResult {
  push: boolean;
  reason: string;
  priority?: "low" | "normal" | "high";
}

export function buildTriagePrompt(
  event: DeviceEvent,
  context: ContextManager,
  profile: TriageProfile | null,
  budget?: { budgetUsed: number; budgetTotal: number },
): string {
  const ctx = context.get();
  const battery = ctx.device.battery;
  const location = ctx.device.location;
  const health = ctx.device.health;
  const activity = ctx.activity;

  const profileSection = profile
    ? `## User Triage Profile\n${profile.summary}\n\nInterruption tolerance: ${profile.interruptionTolerance}`
    : "## User Triage Profile\nNo triage profile available — default to pushing the event.";

  const contextSection = [
    `## Current Device Context`,
    battery ? `Battery: ${Math.round(battery.level * 100)}% (${battery.state})` : null,
    location?.label ? `Location: ${location.label}` : null,
    health?.stepsToday != null ? `Steps today: ${health.stepsToday}` : null,
    activity?.currentZone ? `Zone: ${activity.currentZone}` : null,
    `Time: ${String(new Date().getHours()).padStart(2, "0")}:${String(new Date().getMinutes()).padStart(2, "0")}`,
  ]
    .filter(Boolean)
    .join("\n");

  const budgetSection = budget
    ? `## Push Budget\n${budget.budgetUsed} of ${budget.budgetTotal} pushes used today — be selective.`
    : "";

  return `You are an event triage system for a personal assistant. Decide whether this device event should be pushed as a notification to the user.

${profileSection}

${contextSection}
${budgetSection ? `\n${budgetSection}` : ""}
## Event
- Subscription: ${event.subscriptionId}
- Source: ${event.source}
- Data: ${JSON.stringify(event.data)}
- Fired at: ${new Date(event.firedAt * 1000).toISOString()}
${event.metadata ? `- Metadata: ${JSON.stringify(event.metadata)}` : ""}

Respond with JSON: {"push": boolean, "reason": string, "priority"?: "low"|"normal"|"high"}`;
}

export function parseTriageResponse(text: string): TriageResult {
  try {
    // Strip markdown code fence if present
    const cleaned = text.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    return {
      push: parsed.push === true,
      reason: String(parsed.reason ?? "no reason"),
      priority: ["low", "normal", "high"].includes(parsed.priority) ? parsed.priority : undefined,
    };
  } catch {
    return { push: false, reason: "failed to parse triage response — defaulting to drop" };
  }
}

export async function triageEvent(
  event: DeviceEvent,
  context: ContextManager,
  profile: TriageProfile | null,
  config: { triageModel: string; triageApiBase?: string; budgetUsed?: number; budgetTotal?: number },
  resolveApiKey: () => Promise<string | undefined>,
): Promise<TriageResult> {
  dlog.info("plugin.triage", "triage.called", "sending triage request", {
    subscriptionId: event.subscriptionId,
    model: config.triageModel,
  });

  const prompt = buildTriagePrompt(event, context, profile,
    config.budgetUsed != null && config.budgetTotal != null
      ? { budgetUsed: config.budgetUsed, budgetTotal: config.budgetTotal }
      : undefined
  );

  try {
    const apiKey = await resolveApiKey();
    if (!apiKey) {
      return { push: false, reason: "no API key for triage — defaulting to drop" };
    }

    const baseUrl = config.triageApiBase ?? "https://api.openai.com/v1";
    const model = config.triageModel.includes("/")
      ? config.triageModel.split("/").slice(1).join("/")
      : config.triageModel;

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
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
                push: { type: "boolean" },
                reason: { type: "string" },
                priority: { type: "string", enum: ["low", "normal", "high"] },
              },
              required: ["push", "reason", "priority"],
              additionalProperties: false,
            },
          },
        },
        max_tokens: 150,
        temperature: 0,
      }),
    });

    if (!response.ok) {
      return { push: false, reason: `triage API error: ${response.status} — defaulting to drop` };
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      return { push: false, reason: "empty triage response — defaulting to drop" };
    }

    const result = parseTriageResponse(content);
    dlog.info("plugin.triage", "triage.result", "triage decision", {
      subscriptionId: event.subscriptionId,
      decision: result.push ? "push" : "drop",
      reason: result.reason,
    });
    return result;
  } catch (err) {
    dlog.error("plugin.triage", "triage.fallback", "triage failed, falling back to drop", {
      subscriptionId: event.subscriptionId,
      fallbackAction: "drop",
      ...errorFields(err),
    });
    return { push: false, reason: `triage call failed: ${err} — defaulting to drop` };
  }
}
