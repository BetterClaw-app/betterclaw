import type { ContextManager } from "../context.js";

// Per-field staleness thresholds (seconds)
// Location: updates every ~60s on movement, 10 min threshold
// Health: updates every 30 min, 60 min threshold
const STALE_THRESHOLDS: Record<string, number> = {
  location: 600,
  health: 3600,
};

/** Format seconds into human-readable age string */
export function formatAge(seconds: number): string {
  const clamped = Math.max(0, seconds);
  if (clamped < 60) return `${Math.round(clamped)}s ago`;
  if (clamped < 3600) return `${Math.round(clamped / 60)}m ago`;
  if (clamped < 86400) return `${Math.round(clamped / 3600)}h ago`;
  return `${Math.round(clamped / 86400)}d ago`;
}

/**
 * On premium, stale device data is replaced with a pointer to the fresh
 * node command. Null age is treated as stale on premium (no timestamp =
 * can't verify freshness).
 */
function deviceFieldOrPointer(
  data: Record<string, unknown> | null,
  ageSeconds: number | null,
  freshCommand: string,
  isPremium: boolean,
  field: string,
): Record<string, unknown> | null {
  if (!data) return null;
  const threshold = STALE_THRESHOLDS[field] ?? 600;
  if (isPremium && (ageSeconds == null || ageSeconds > threshold)) {
    return {
      stale: true,
      ageHuman: ageSeconds != null ? formatAge(ageSeconds) : "unknown",
      freshCommand,
    };
  }
  return { ...data, dataAgeSeconds: ageSeconds };
}

export function createGetContextTool(ctx: ContextManager, _stateDir?: string) {
  return {
    name: "get_context",
    label: "Get Device Context",
    description:
      "Get BetterClaw context — patterns, trends, activity zone, and event history. On premium, stale device readings are hidden — use node commands (location.get, health.*) for current data. On free, this includes the full device snapshot.",
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
            ? "Node commands available for fresh readings (location.get, health.*). Stale device data is hidden — call the node command instead."
            : "This is the only data source on free tier — check dataAgeSeconds for freshness",
        },
        smartMode: runtime.smartMode,
      };

      result.device = {
        location: deviceFieldOrPointer(
          state.device.location as unknown as Record<string, unknown>,
          dataAge.location,
          "location.get",
          isPremium,
          "location",
        ),
        health: deviceFieldOrPointer(
          state.device.health as unknown as Record<string, unknown>,
          dataAge.health,
          "health.summary",
          isPremium,
          "health",
        ),
      };

      result.activity = { ...state.activity, updatedAt: ctx.getTimestamp("activity") };

      if (patterns) result.patterns = patterns;

      result.meta = {
        ...state.meta,
        lastSnapshotAt: ctx.getTimestamp("lastSnapshot"),
        lastAnalysisAt: patterns?.computedAt,
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        details: undefined,
      };
    },
  };
}
