import type { DeviceEvent, TriageProfile } from "./types.js";
import type { ContextManager } from "./context.js";

export interface TriageResult {
  push: boolean;
  reason: string;
  priority?: "low" | "normal" | "high";
}

export function buildTriagePrompt(
  event: DeviceEvent,
  context: ContextManager,
  profile: TriageProfile | null,
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

  return `You are an event triage system for a personal assistant. Decide whether this device event should be pushed as a notification to the user.

${profileSection}

${contextSection}

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
    return { push: true, reason: "failed to parse triage response" };
  }
}

export async function triageEvent(
  event: DeviceEvent,
  context: ContextManager,
  profile: TriageProfile | null,
  config: { triageModel: string; triageApiBase?: string },
  resolveApiKey: () => Promise<string | undefined>,
): Promise<TriageResult> {
  const prompt = buildTriagePrompt(event, context, profile);

  try {
    const apiKey = await resolveApiKey();
    if (!apiKey) {
      return { push: true, reason: "no API key for triage — defaulting to push" };
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
      return { push: true, reason: `triage API error: ${response.status}` };
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      return { push: true, reason: "empty triage response" };
    }

    return parseTriageResponse(content);
  } catch (err) {
    return { push: true, reason: `triage call failed: ${err}` };
  }
}
