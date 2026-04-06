import type { ContextManager } from "../context.js";
import { loadTriageProfile } from "../learner.js";

export function createGetContextTool(ctx: ContextManager, stateDir?: string) {
  return {
    name: "get_context",
    label: "Get Device Context",
    description:
      "Get BetterClaw context — patterns, trends, activity zone, event history, and cached device snapshots with staleness indicators. On premium, node commands return fresher data for current readings. On free, this includes the latest device snapshot.",
    parameters: {},
    async execute(_id: string, _params: Record<string, unknown>) {
      const state = ctx.get();
      const runtime = ctx.getRuntimeState();
      const patterns = await ctx.readPatterns();
      const dataAge = ctx.getDataAge();

      const isPremium = runtime.tier === "premium";

      const result: Record<string, unknown> = {
        tierHint: {
          tier: runtime.tier,
          note: isPremium
            ? "Node commands available for fresh readings (location.get, device.battery, health.*)"
            : "This is the only data source on free tier — check dataAgeSeconds for freshness",
        },
        smartMode: runtime.smartMode,
      };

      result.device = {
        battery: state.device.battery
          ? { ...state.device.battery, updatedAt: ctx.getTimestamp("battery"), dataAgeSeconds: dataAge.battery }
          : null,
        location: state.device.location
          ? { ...state.device.location, updatedAt: ctx.getTimestamp("location"), dataAgeSeconds: dataAge.location }
          : null,
        health: state.device.health
          ? { ...state.device.health, updatedAt: ctx.getTimestamp("health"), dataAgeSeconds: dataAge.health }
          : null,
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
      };
    },
  };
}
