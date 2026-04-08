import type { ContextManager } from "../context.js";
import { loadTriageProfile } from "../learner.js";

const STALE_THRESHOLD_S = 600; // 10 minutes

/** Format seconds into human-readable age string */
function formatAge(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

/**
 * On premium, stale device data (>10 min) is replaced with a pointer
 * to the fresh node command. The agent can't shortcut to stale values.
 */
function deviceFieldOrPointer(
  data: Record<string, unknown> | null,
  ageSeconds: number | null,
  freshCommand: string,
  isPremium: boolean,
): Record<string, unknown> | null {
  if (!data) return null;
  if (isPremium && ageSeconds != null && ageSeconds > STALE_THRESHOLD_S) {
    return { stale: true, ageHuman: formatAge(ageSeconds), freshCommand };
  }
  return { ...data, dataAgeSeconds: ageSeconds };
}

export function createGetContextTool(ctx: ContextManager, stateDir?: string) {
  return {
    name: "get_context",
    label: "Get Device Context",
    description:
      "Get BetterClaw context — patterns, trends, activity zone, and event history. On premium, stale device readings (>10 min) are hidden — use node commands (location.get, device.battery, health.*) for current data. On free, this includes the full device snapshot.",
    parameters: {},
    async execute(_id: string, _params: Record<string, unknown>) {
      const state = ctx.get();
      const runtime = ctx.getRuntimeState();
      const patterns = await ctx.readPatterns();
      const dataAge = ctx.getDataAge();

      const isPremium = runtime.tier === "premium" || runtime.tier === "premium+";

      const result: Record<string, unknown> = {
        tierHint: {
          tier: runtime.tier,
          note: isPremium
            ? "Node commands available for fresh readings (location.get, device.battery, health.*). Stale device data is hidden — call the node command instead."
            : "This is the only data source on free tier — check dataAgeSeconds for freshness",
        },
        smartMode: runtime.smartMode,
      };

      result.device = {
        battery: deviceFieldOrPointer(
          state.device.battery as unknown as Record<string, unknown>,
          dataAge.battery,
          "device.battery",
          isPremium,
        ),
        location: deviceFieldOrPointer(
          state.device.location as unknown as Record<string, unknown>,
          dataAge.location,
          "location.get",
          isPremium,
        ),
        health: deviceFieldOrPointer(
          state.device.health as unknown as Record<string, unknown>,
          dataAge.health,
          "health.summary",
          isPremium,
        ),
      };

      result.activity = { ...state.activity, updatedAt: ctx.getTimestamp("activity") };

      if (patterns) result.patterns = patterns;

      result.meta = {
        ...state.meta,
        lastSnapshotAt: ctx.getTimestamp("lastSnapshot"),
        lastAnalysisAt: patterns?.computedAt,
      };

      const profile = stateDir ? await loadTriageProfile(stateDir) : null;
      result.triageProfile = profile ? { summary: profile.summary, computedAt: profile.computedAt } : null;

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        details: undefined,
      };
    },
  };
}
