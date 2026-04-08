import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { ContextManager } from "./context.js";
import type { EventLog } from "./events.js";
import type { RulesEngine } from "./filter.js";
import type { ReactionTracker } from "./reactions.js";
import type { DeviceEvent, DeviceContext, PluginConfig } from "./types.js";
import { errorMessage } from "./types.js";
import { triageEvent } from "./triage.js";
import { loadTriageProfile } from "./learner.js";
import { requireEntitlement } from "./jwt.js";
import { dlog } from "./diagnostic-logger.js";

export interface PipelineDeps {
  api: OpenClawPluginApi;
  config: PluginConfig;
  context: ContextManager;
  events: EventLog;
  rules: RulesEngine;
  reactions: ReactionTracker;
  stateDir: string;
}

export async function processEvent(deps: PipelineDeps, event: DeviceEvent): Promise<void> {
  const { api, config, context, events, rules } = deps;

  dlog.info("plugin.pipeline", "event.received", "incoming device event", { subscriptionId: event.subscriptionId, source: event.source });

  // Always update context (even for non-premium users)
  context.updateFromEvent(event);
  await context.save();

  // Tier gate: free users get store-only path — no triage, no push
  if (context.getRuntimeState().tier === "free") {
    dlog.info("plugin.pipeline", "event.free_stored", "event stored (free tier)", { subscriptionId: event.subscriptionId });
    await events.append({ event, decision: "free_stored", reason: "free tier", timestamp: Date.now() / 1000 });
    return;
  }

  // Gate event forwarding behind premium entitlement (security boundary)
  const entitlementError = requireEntitlement("premium");
  if (entitlementError) {
    dlog.info("plugin.pipeline", "event.blocked", "event blocked (no premium entitlement)", { subscriptionId: event.subscriptionId });
    await events.append({ event, decision: "blocked", reason: "no premium entitlement", timestamp: Date.now() / 1000 });
    return;
  }

  // If smartMode is OFF, store only — no filtering or pushing
  if (!context.getRuntimeState().smartMode) {
    await events.append({ event, decision: "stored", reason: "smartMode off", timestamp: Date.now() / 1000 });
    return;
  }

  // Run rules engine
  const deviceConfig = context.getDeviceConfig();
  const effectiveBudget = deviceConfig.pushBudgetPerDay ?? config.pushBudgetPerDay;
  const decision = rules.evaluate(event, context.get(), effectiveBudget);

  // Ambiguous events go through LLM triage
  if (decision.action === "ambiguous") {
    const profile = await loadTriageProfile(deps.stateDir);
    const triageResult = await triageEvent(
      event,
      deps.context,
      profile,
      { triageModel: deps.config.triageModel, triageApiBase: deps.config.triageApiBase, budgetUsed: context.get().meta.pushesToday, budgetTotal: effectiveBudget },
      async () => {
        try {
          const auth = await deps.api.runtime.modelAuth.resolveApiKeyForProvider({
            provider: deps.config.triageModel.includes("/")
              ? deps.config.triageModel.split("/")[0]
              : "openai",
          });
          return auth.apiKey;
        } catch {
          return undefined;
        }
      },
    );

    if (triageResult.push) {
      const message = formatEnrichedMessage(event, deps.context);
      const pushed = await pushToAgent(deps, event, `triage: ${triageResult.reason}`, message);

      if (pushed) {
        rules.recordFired(event.subscriptionId, event.firedAt, event.data);
        context.recordPush();
        deps.reactions.recordPush({
          subscriptionId: event.subscriptionId,
          source: event.source,
          pushedAt: Date.now() / 1000,
          messageSummary: message.slice(0, 100),
        });
        dlog.info("plugin.pipeline", "push.decided", "event pushed to agent via triage", { subscriptionId: event.subscriptionId, decision: "push", reason: `triage: ${triageResult.reason}` });
      }

      await events.append({
        event,
        decision: pushed ? "push" : "drop",
        reason: pushed ? `triage: ${triageResult.reason}` : `triage push failed: ${triageResult.reason}`,
        timestamp: Date.now() / 1000,
      });
    } else {
      await events.append({
        event,
        decision: "drop",
        reason: `triage: ${triageResult.reason}`,
        timestamp: Date.now() / 1000,
      });
    }

    await context.save();
    await deps.reactions.save();
    return;
  }

  if (decision.action === "push") {
    const message = formatEnrichedMessage(event, deps.context);
    const pushed = await pushToAgent(deps, event, decision.reason, message);

    if (pushed) {
      rules.recordFired(event.subscriptionId, event.firedAt, event.data);
      context.recordPush();
      deps.reactions.recordPush({
        subscriptionId: event.subscriptionId,
        source: event.source,
        pushedAt: Date.now() / 1000,
        messageSummary: message.slice(0, 100),
      });
      dlog.info("plugin.pipeline", "push.decided", "event pushed to agent", { subscriptionId: event.subscriptionId, decision: "push", reason: decision.reason });
    }

    await events.append({
      event,
      decision: pushed ? "push" : "drop",
      reason: pushed ? decision.reason : `push failed: ${decision.reason}`,
      timestamp: Date.now() / 1000,
    });
  } else {
    await events.append({
      event,
      decision: "drop",
      reason: decision.reason,
      timestamp: Date.now() / 1000,
    });
    dlog.info("plugin.pipeline", "push.decided", "event dropped", { subscriptionId: event.subscriptionId, decision: "drop", reason: decision.reason });
  }

  // Persist context and reactions
  await context.save();
  await deps.reactions.save();
}

async function pushToAgent(deps: PipelineDeps, event: DeviceEvent, reason: string, message: string): Promise<boolean> {
  const idempotencyKey = `event-${event.subscriptionId}-${Math.floor(event.firedAt)}`;

  try {
    await deps.api.runtime.subagent.run({
      sessionKey: "main",
      message,
      deliver: false,
      idempotencyKey,
    });
    dlog.info("plugin.pipeline", "push.sent", "event pushed to agent", { subscriptionId: event.subscriptionId });
    return true;
  } catch (err) {
    const msg = errorMessage(err);
    dlog.error("plugin.pipeline", "push.failed", "failed to push event to agent", { subscriptionId: event.subscriptionId, error: msg });
    return false;
  }
}

function formatEnrichedMessage(event: DeviceEvent, context: ContextManager): string {
  const state = context.get();
  const body = formatEventBody(event);
  const contextSummary = formatContextSummary(state);

  const prefix =
    event.data._debugFired === 1.0
      ? "[DEBUG test event fired manually from BetterClaw iOS debug menu — not a real device event. You MUST respond to confirm the pipeline is working.]"
      : "[BetterClaw device event — processed by context plugin]";

  return `${prefix}\n\n${body}\n\nCurrent context: ${contextSummary}`;
}

function formatEventBody(event: DeviceEvent): string {
  const data = event.data;
  const id = event.subscriptionId;

  switch (id) {
    case "default.battery-low": {
      const level = data.level != null ? Math.round(data.level * 100) : "?";
      return `🔋 Battery at ${level}% (threshold: <20%)`;
    }
    case "default.battery-critical": {
      const level = data.level != null ? Math.round(data.level * 100) : "?";
      return `🪫 Battery at ${level}% (threshold: <10%)`;
    }
    case "default.daily-health": {
      const parts: string[] = [];
      if (data.stepsToday != null) parts.push(`Steps: ${Math.round(data.stepsToday).toLocaleString()}`);
      if (data.distanceMeters != null) parts.push(`Distance: ${(data.distanceMeters / 1000).toFixed(1)}km`);
      if (data.heartRateAvg != null) parts.push(`Avg HR: ${Math.round(data.heartRateAvg)}bpm`);
      if (data.sleepDurationSeconds != null) {
        const h = Math.floor(data.sleepDurationSeconds / 3600);
        const m = Math.floor((data.sleepDurationSeconds % 3600) / 60);
        parts.push(`Sleep: ${h}h ${m}m`);
      }
      const summary = parts.length ? parts.join(" | ") : "No data";
      return `🏥 Daily health summary — ${summary}`;
    }
    default: {
      if (event.source === "geofence.triggered") {
        const type = data.type === 1 ? "enter" : "exit";
        const emoji = type === "enter" ? "📍" : "🚶";
        const zone = event.metadata?.zoneName;
        return zone
          ? `${emoji} Geofence ${type}: ${zone}`
          : `${emoji} Geofence ${type}`;
      }
      if (event.source.startsWith("health")) {
        const pairs = Object.entries(data)
          .filter(([k]) => k !== "_debugFired" && k !== "updatedAt")
          .map(([k, v]) => `${k}: ${v}`)
          .join(", ");
        return `🏥 Health event — ${pairs}`;
      }
      const pairs = Object.entries(data)
        .filter(([k]) => k !== "_debugFired")
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ");
      return `📡 ${event.source} — ${pairs}`;
    }
  }
}

function formatContextSummary(state: DeviceContext): string {
  const parts: string[] = [];

  if (state.activity.currentZone) {
    const since = state.activity.zoneEnteredAt
      ? `since ${formatDuration(Date.now() / 1000 - state.activity.zoneEnteredAt)}`
      : "";
    parts.push(`At ${state.activity.currentZone} ${since}`.trim());
  }

  if (state.device.health?.stepsToday) {
    parts.push(`${Math.round(state.device.health.stepsToday).toLocaleString()} steps today`);
  }

  if (state.device.battery) {
    parts.push(`Battery ${Math.round(state.device.battery.level * 100)}% (${state.device.battery.state})`);
  }

  return parts.length ? parts.join(". ") + "." : "No context available.";
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return "<1m";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}
