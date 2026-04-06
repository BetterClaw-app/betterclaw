import { Type } from "@sinclair/typebox";
import type { ContextManager } from "../context.js";

export interface CheckTierState {
  calibrating: boolean;
  calibrationEndsAt?: number;
}

export function createCheckTierTool(ctx: ContextManager, getState: () => CheckTierState) {
  return {
    name: "check_tier",
    label: "Check Device Tier",
    description:
      "Check the user's BetterClaw subscription tier and get instructions for how to access their device data. Call this first before accessing device data, or use your cached tier if still valid.",
    parameters: Type.Object({}),
    async execute(_id: string, _params: Record<string, unknown>) {
      const state = getState();
      const runtime = ctx.getRuntimeState();

      if (runtime.tier === null) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              tier: "unknown",
              dataPath: "Tier not yet determined — the device hasn't connected. Try again shortly.",
              cacheUntil: Math.floor(Date.now() / 1000) + 60,
              cacheInstruction: "Re-check in about a minute.",
            }, null, 2),
          }],
        };
      }
      const cacheUntil = Math.floor(Date.now() / 1000) + 86400;

      const isPremium = runtime.tier === "premium" || runtime.tier === "premium+";

      const dataPath = isPremium
        ? "Use node commands for current device readings: location.get, device.battery, health.steps, health.heartrate, health.hrv, health.sleep, health.distance, health.restinghr, health.workouts, health.summary, geofence.list. Use get_context for patterns, trends, history, and broad situational awareness — its device snapshot may not be perfectly recent but is useful for the big picture."
        : "Use get_context for all device data. This is a cached snapshot from the last time the user had BetterClaw open — check timestamps for freshness. You cannot query fresh data on free tier.";

      const cacheInstruction = `Save your tier and data path to your memory. Re-check after cacheUntil (${new Date(cacheUntil * 1000).toISOString()}). Until then, use the cached tier to decide how to access device data.`;

      const result: Record<string, unknown> = {
        tier: runtime.tier,
        dataPath,
        cacheUntil,
        cacheInstruction,
      };

      if (state.calibrating) {
        result.calibrating = true;
        result.calibrationEndsAt = state.calibrationEndsAt;
        result.calibrationNote = "BetterClaw's smart filtering is still calibrating — it needs a few days to learn your preferences. Events are being tracked but filtering is in rules-only mode.";
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  };
}
