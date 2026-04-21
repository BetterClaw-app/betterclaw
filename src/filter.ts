import type { DeviceContext, DeviceEvent, FilterDecision } from "./types.js";

export class RulesEngine {
  private lastFired: Map<string, number> = new Map();
  private pushBudget: number;
  private cooldowns: Record<string, number>;
  private defaultCooldown: number;

  constructor(pushBudget: number = 10, cooldowns: Record<string, number> = {}, defaultCooldown: number = 1800) {
    this.pushBudget = pushBudget;
    this.cooldowns = cooldowns;
    this.defaultCooldown = defaultCooldown;
  }

  evaluate(event: DeviceEvent, context: DeviceContext, budgetOverride?: number, now: number = Date.now() / 1000): FilterDecision {
    // Note: debug and geofence events intentionally bypass the push
    // budget check below. These are high-priority events that should always reach the
    // agent regardless of daily budget limits.

    // Debug events always pass
    if (event.data._debugFired === 1.0) {
      return { action: "push", reason: "debug event — always push" };
    }

    // Dedup check. Uses gateway ingestion time (`now`) rather than iOS
    // `event.firedAt` because iOS wall-clock can drift or jump backwards via
    // NTP correction, which previously produced negative deltas like
    // "fired -253s ago" and silently dropped legitimate re-fires.
    const lastFiredAt = this.lastFired.get(event.subscriptionId);
    const cooldown = this.cooldowns[event.subscriptionId] ?? this.defaultCooldown;
    if (lastFiredAt && now - lastFiredAt < cooldown) {
      return {
        action: "drop",
        reason: `dedup: ${event.subscriptionId} fired ${Math.round(now - lastFiredAt)}s ago (cooldown: ${cooldown}s)`,
      };
    }

    // Geofence — always push
    if (event.source === "geofence.triggered") {
      return { action: "push", reason: "geofence event — always push" };
    }

    // Push budget check
    const budget = budgetOverride ?? this.pushBudget;
    if (context.meta.pushesToday >= budget) {
      return { action: "drop", reason: `push budget exhausted (${context.meta.pushesToday}/${budget} today)` };
    }

    // Anything else is ambiguous — forward to LLM judgment
    return { action: "ambiguous", reason: "no rule matched — forward to LLM judgment" };
  }

  recordFired(subscriptionId: string, at: number = Date.now() / 1000): void {
    this.lastFired.set(subscriptionId, at);
  }

  /** Restore cooldown state (call on load). `at` values are gateway ingestion
   *  timestamps (e.g. EventLogEntry.timestamp), not iOS event.firedAt. */
  restoreCooldowns(entries: Array<{ subscriptionId: string; at: number }>): void {
    for (const { subscriptionId, at } of entries) {
      const existing = this.lastFired.get(subscriptionId);
      if (!existing || at > existing) {
        this.lastFired.set(subscriptionId, at);
      }
    }
  }
}
