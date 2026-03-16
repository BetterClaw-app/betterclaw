import { Type } from "@sinclair/typebox";
import type { ContextManager } from "../context.js";
import { loadTriageProfile } from "../learner.js";

export function createGetContextTool(ctx: ContextManager, stateDir?: string) {
  return {
    name: "get_context",
    label: "Get Device Context",
    description:
      "Get the current physical context of the user's iPhone — battery, location, health metrics, activity zone, patterns, and trends. Call this when you need to know about the user's physical state.",
    parameters: Type.Object({
      include: Type.Optional(
        Type.Array(Type.String(), {
          description: "Sections to include. Omit for all. Options: device, activity, patterns, meta",
        }),
      ),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const sections =
        Array.isArray(params.include) && params.include.every((s) => typeof s === "string")
          ? (params.include as string[])
          : ["device", "activity", "patterns", "meta"];

      const state = ctx.get();
      const runtime = ctx.getRuntimeState();
      const patterns = await ctx.readPatterns();

      const result: Record<string, unknown> = {
        tier: runtime.tier,
        smartMode: runtime.smartMode,
      };

      if (sections.includes("device")) {
        result.device = {
          battery: state.device.battery ? { ...state.device.battery, updatedAt: ctx.getTimestamp("battery") } : null,
          location: state.device.location ? { ...state.device.location, updatedAt: ctx.getTimestamp("location") } : null,
          health: state.device.health ? { ...state.device.health, updatedAt: ctx.getTimestamp("health") } : null,
        };
      }
      if (sections.includes("activity")) {
        result.activity = { ...state.activity, updatedAt: ctx.getTimestamp("activity") };
      }
      if (sections.includes("patterns") && patterns) result.patterns = patterns;
      if (sections.includes("meta")) {
        result.meta = {
          ...state.meta,
          lastSnapshotAt: ctx.getTimestamp("lastSnapshot"),
          lastAnalysisAt: patterns?.computedAt,
        };
      }

      const profile = stateDir ? await loadTriageProfile(stateDir) : null;
      result.triageProfile = profile ? { summary: profile.summary, computedAt: profile.computedAt } : null;

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  };
}
