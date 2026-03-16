import type { DeviceContext, DeviceEvent, FilterDecision } from "./types.js";

// Cooldowns in seconds
const DEDUP_COOLDOWN: Record<string, number> = {
  "default.battery-low": 3600,
  "default.battery-critical": 1800,
  "default.daily-health": 82800, // 23 hours
  "default.geofence": 300,
};

const DEFAULT_COOLDOWN = 1800; // 30 minutes

export class RulesEngine {
  private lastFired: Map<string, number> = new Map();
  private pushBudget: number;

  constructor(pushBudget: number = 10) {
    this.pushBudget = pushBudget;
  }

  evaluate(event: DeviceEvent, context: DeviceContext): FilterDecision {
    // Debug events always pass
    if (event.data._debugFired === 1.0) {
      return { action: "push", reason: "debug event — always push" };
    }

    // Dedup check
    const lastFiredAt = this.lastFired.get(event.subscriptionId);
    const cooldown = DEDUP_COOLDOWN[event.subscriptionId] ?? DEFAULT_COOLDOWN;
    if (lastFiredAt && event.firedAt - lastFiredAt < cooldown) {
      return {
        action: "drop",
        reason: `dedup: ${event.subscriptionId} fired ${Math.round(event.firedAt - lastFiredAt)}s ago (cooldown: ${cooldown}s)`,
      };
    }

    // Critical battery — always push
    if (event.subscriptionId === "default.battery-critical") {
      return { action: "push", reason: "critical battery — always push" };
    }

    // Geofence — always push
    if (event.source === "geofence.triggered") {
      return { action: "push", reason: "geofence event — always push" };
    }

    // Battery low — check if level changed since last push
    if (event.subscriptionId === "default.battery-low") {
      const currentLevel = event.data.level;
      const lastLevel = context.device.battery?.level;
      if (
        lastLevel !== undefined &&
        currentLevel !== undefined &&
        Math.abs(currentLevel - lastLevel) < 0.02
      ) {
        return { action: "drop", reason: "battery-low: level unchanged since last push" };
      }
      return { action: "push", reason: "battery low — level changed" };
    }

    // Daily health — check time window
    if (event.subscriptionId === "default.daily-health") {
      const hour = new Date(event.firedAt * 1000).getHours();
      // Preferred window: 6am-10am
      if (hour >= 6 && hour <= 10) {
        return { action: "push", reason: "daily health summary — within morning window" };
      }
      return { action: "drop", reason: "daily health summary — outside morning window" };
    }

    // Push budget check
    if (context.meta.pushesToday >= this.pushBudget) {
      return { action: "drop", reason: `push budget exhausted (${context.meta.pushesToday}/${this.pushBudget} today)` };
    }

    // Anything else is ambiguous — forward to LLM judgment
    return { action: "ambiguous", reason: "no rule matched — forward to LLM judgment" };
  }

  recordFired(subscriptionId: string, firedAt: number): void {
    this.lastFired.set(subscriptionId, firedAt);
  }

  /** Restore cooldown state (call on load) */
  restoreCooldowns(entries: Array<{ subscriptionId: string; firedAt: number }>): void {
    for (const { subscriptionId, firedAt } of entries) {
      const existing = this.lastFired.get(subscriptionId);
      if (!existing || firedAt > existing) {
        this.lastFired.set(subscriptionId, firedAt);
      }
    }
  }
}
