import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { ContextManager } from "./context.js";
import type { EventLog } from "./events.js";
import type { RulesEngine } from "./filter.js";
import type { ReactionTracker } from "./reactions.js";
import type { DeviceEvent, DeviceContext, PluginConfig } from "./types.js";
import { triageEvent } from "./triage.js";
import { requireEntitlement } from "./jwt.js";
import { errorFields } from "./errors.js";
import { dlog } from "./diagnostic-logger.js";
import { matchEvent } from "./routing/rule-matcher.js";
import { computeLockedKeys } from "./routing/audit-log.js";
import type { RoutingConfigStore } from "./routing/config-store.js";
import type { AuditLog } from "./routing/audit-log.js";
import type { RoutingAction } from "./routing/types.js";

export interface PipelineDeps {
  api: OpenClawPluginApi;
  config: PluginConfig;
  context: ContextManager;
  events: EventLog;
  rules: RulesEngine;
  reactions: ReactionTracker;
  stateDir: string;
  routing: RoutingConfigStore;
  audit: AuditLog;
}

export async function processEvent(deps: PipelineDeps, event: DeviceEvent): Promise<void> {
  const { config, context, events, rules } = deps;

  dlog.info("plugin.pipeline", "event.received", "incoming device event", { subscriptionId: event.subscriptionId, source: event.source });

  // Always update context (even for non-premium users)
  context.updateFromEvent(event);
  await context.save();

  // Tier gate: free users get store-only path — no triage, no push
  if (context.getRuntimeState().tier === "free") {
    dlog.info("plugin.pipeline", "event.free.stored", "event stored (free tier)", { subscriptionId: event.subscriptionId });
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

  // Existing RulesEngine: handles cooldowns, dedup, debug-bypass, push-budget.
  // Its output is the cheap first-pass filter; routing only runs when it
  // returns non-drop.
  const deviceConfig = context.getDeviceConfig();
  const effectiveBudget = deviceConfig.pushBudgetPerDay ?? config.pushBudgetPerDay;
  const ruleDecision = rules.evaluate(event, context.get(), effectiveBudget);

  if (ruleDecision.action === "drop") {
    await events.append({ event, decision: "drop", reason: ruleDecision.reason, timestamp: Date.now() / 1000 });
    dlog.info("plugin.pipeline", "push.decided", "event dropped by rules engine",
      { subscriptionId: event.subscriptionId, decision: "drop", reason: ruleDecision.reason });
    await context.save();
    await deps.reactions.save();
    return;
  }

  // Reactive auto-rule: if this is a geofence event for a never-seen zoneName, insert
  // a default notify rule and re-run routing-rules matching. Fails open on errors.
  if (event.source === "geofence.triggered") {
    const label = event.metadata?.zoneName;
    if (label) {
      const currentRules = deps.routing.getRules().rules;
      const alreadyCovered = currentRules.some(r => {
        if (typeof r.match !== "object") return false;
        const m = r.match as { geofenceLabel?: string };
        return m.geofenceLabel === label;
      });
      if (!alreadyCovered) {
        const baseId = `geofence-${slugify(label)}-auto`;
        const newRuleId = uniqueRuleId(baseId, currentRules.map(r => r.id));
        const insertAt = currentRules.length > 0 && currentRules[currentRules.length - 1].match === "*"
          ? currentRules.length - 1
          : currentRules.length;
        try {
          const result = await deps.routing.applyPatch(
            [{
              op: "add",
              path: `/rules/${insertAt}`,
              value: {
                id: newRuleId,
                match: { source: "geofence.triggered", geofenceLabel: label },
                action: "notify",
                explicit: false,
              },
            }],
            "default",
            `new geofence observed: ${label}`,
          );
          if (result.applied.length > 0) {
            dlog.info("plugin.routing", "autorule.inserted", "auto-rule inserted", { ruleId: newRuleId });
          }
        } catch (err) {
          dlog.error("plugin.routing", "autorule.failed", "auto-rule insert failed",
            { ...errorFields(err) });
        }
      }
    }
  }

  // Rule match against routing-rules.json (post-insert view)
  const routing = deps.routing.getRules();
  const match = matchEvent(event, routing.rules);

  // Resolve current local time for quiet-hours check using the device-reported tz
  const tz = context.getRuntimeState().tz ?? routing.quietHours.tz;
  const currentLocalTime = formatHourMinute(new Date(), tz === "auto" ? undefined : tz);

  let action: RoutingAction;
  let reason: string;

  if (match && match.rule.explicit) {
    action = match.action;
    reason = `rule ${match.rule.id} (explicit)`;
  } else {
    // Non-explicit path: call cheap triage LLM with rule priors as context
    const now = Math.floor(Date.now() / 1000);
    const audit = await deps.audit.readSince(now - 14 * 86400);
    const lockedKeys = computeLockedKeys(audit, now, 14 * 86400);
    const recentUserEdits = audit.filter(e => e.source === "user" && e.ts > now - 3 * 86400);
    const matchedNonExplicit = match ? [match.rule] : [];

    // Follow the existing resolveApiKey pattern from pipeline.ts:67-77
    const resolveApiKey = async () => {
      try {
        const auth = await deps.api.runtime.modelAuth.resolveApiKeyForProvider({
          provider: config.triageModel.includes("/") ? config.triageModel.split("/")[0] : "openai",
        });
        return auth.apiKey;
      } catch {
        return undefined;
      }
    };

    let triage: { action: RoutingAction; reason: string };
    try {
      triage = await triageEvent(
        event, deps.context, matchedNonExplicit, lockedKeys, recentUserEdits,
        routing.quietHours, currentLocalTime,
        {
          triageModel: config.triageModel,
          triageApiBase: config.triageApiBase,
          budgetUsed: context.get().meta.pushesToday,
          budgetTotal: effectiveBudget,
        },
        resolveApiKey,
      );
    } catch (err) {
      // Hard fallback: if triageEvent throws synchronously before its own try/catch,
      // default to drop so invariant TERNARY_EXHAUSTIVE holds.
      dlog.error("plugin.triage", "triage.fallback", "triage threw unexpectedly", { ...errorFields(err) });
      triage = { action: "drop", reason: "triage crashed; defaulted to drop" };
    }

    action = triage.action;
    reason = triage.reason;
  }

  // Quiet-hours demotion (applies to both explicit and LLM paths).
  // respectQuietHours: undefined → true (default); false only if explicitly disabled.
  if (action === "notify" && match?.rule.respectQuietHours !== false) {
    if (isInQuietHours(currentLocalTime, routing.quietHours)) {
      action = "push";
      reason = `${reason} (quiet-hours-demoted)`;
    }
  }

  // Dispatch
  if (action === "drop") {
    dlog.info("plugin.pipeline", "push.decided", "event dropped by routing",
      { subscriptionId: event.subscriptionId, decision: "drop", reason });
    await events.append({ event, decision: "drop", reason, timestamp: Date.now() / 1000 });
    await context.save();
    await deps.reactions.save();
    return;
  }

  const deliver = action === "notify";
  const message = formatEnrichedMessage(event, deps.context);

  try {
    await deps.api.runtime.subagent.run({
      sessionKey: "main",
      message,
      deliver,
      idempotencyKey: `event-${event.subscriptionId}-${Math.floor(event.firedAt)}`,
    });
    // Record push — feeds RulesEngine cooldowns + push-budget + reactions.
    rules.recordFired(event.subscriptionId, event.firedAt, event.data);
    context.recordPush();
    deps.reactions.recordPush({
      subscriptionId: event.subscriptionId,
      source: event.source,
      pushedAt: Date.now() / 1000,
      messageSummary: message.slice(0, 100),
    });
    dlog.info("plugin.pipeline", deliver ? "event.notified" : "event.pushed",
      deliver ? "event dispatched as notify" : "event dispatched as push",
      { subscriptionId: event.subscriptionId });
    await events.append({ event, decision: deliver ? "notify" : "push", reason, timestamp: Date.now() / 1000 });
  } catch (err) {
    dlog.error("plugin.pipeline", "push.failed", "failed to dispatch event",
      { subscriptionId: event.subscriptionId, ...errorFields(err) });
    await events.append({ event, decision: "drop", reason: `dispatch failed: ${err}`, timestamp: Date.now() / 1000 });
  }

  await context.save();
  await deps.reactions.save();
}

export function formatEnrichedMessage(event: DeviceEvent, context: ContextManager): string {
  const state = context.get();
  const body = formatEventBody(event);
  const contextSummary = formatContextSummary(state);

  const prefix =
    event.data._debugFired === 1.0
      ? "[DEBUG test event fired manually from BetterClaw iOS debug menu — not a real device event. You MUST respond to confirm the pipeline is working.]"
      : "[BetterClaw device event — processed by context plugin]";

  return `${prefix}\n\n${body}\n\nCurrent context: ${contextSummary}`;
}

export function formatEventBody(event: DeviceEvent): string {
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

export function formatContextSummary(state: DeviceContext): string {
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

export function formatDuration(seconds: number): string {
  if (seconds < 60) return "<1m";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function uniqueRuleId(base: string, existing: string[]): string {
  if (!existing.includes(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!existing.includes(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

/**
 * Format the current time as "HH:MM" in the given IANA tz, using h23 cycle
 * (0–23). Avoids the "24:xx" quirk that some Node versions emit with
 * hour12: false on toLocaleTimeString.
 */
function formatHourMinute(d: Date, tz?: string): string {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  });
  return fmt.format(d);
}

function isInQuietHours(currentLocalTime: string, q: { start: string; end: string }): boolean {
  const toMinutes = (hhmm: string): number => {
    const [h, m] = hhmm.split(":").map(Number);
    return h * 60 + m;
  };
  const now = toMinutes(currentLocalTime);
  const start = toMinutes(q.start);
  const end = toMinutes(q.end);
  return start < end
    ? now >= start && now < end
    : now >= start || now < end; // wraps midnight
}
