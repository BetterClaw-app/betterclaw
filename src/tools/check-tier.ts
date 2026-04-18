import { Type } from "@sinclair/typebox";
import type { ContextManager } from "../context.js";

export function createCheckTierTool(ctx: ContextManager) {
  return {
    name: "check_tier",
    label: "Check Device Tier",
    description:
      "Check the user's BetterClaw subscription tier and get instructions for how to access their device data. Call this first before accessing device data, or use your cached tier if still valid.",
    parameters: Type.Object({}),
    async execute(_id: string, _params: Record<string, unknown>) {
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
          details: undefined,
        };
      }
      const cacheUntil = Math.floor(Date.now() / 1000) + 86400;

      const isPremium = runtime.tier === "premium";

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

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        details: undefined,
      };
    },
  };
}
