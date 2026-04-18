// src/tools/edit-routing-rules.ts
import { Type } from "@sinclair/typebox";
import type { RoutingConfigStore } from "../routing/config-store.js";
import { dlog } from "../diagnostic-logger.js";

export function createEditRoutingRulesTool(store: () => RoutingConfigStore) {
  return {
    name: "edit_routing_rules",
    label: "Edit BetterClaw Routing Rules",
    description: "Propose a JSON Patch (RFC 6902) to the user's routing rules config. Ops targeting keys the user has recently edited will be dropped. Use this to tune notification behavior based on the user's reactions or explicit requests.",
    parameters: Type.Object({
      patch: Type.Array(Type.Object({
        op: Type.Union([Type.Literal("replace"), Type.Literal("add"), Type.Literal("remove")]),
        path: Type.String(),
        value: Type.Optional(Type.Unknown()),
      })),
      reason: Type.String(),
    }),
    async execute(_id: string, params: { patch: unknown[]; reason: string }) {
      const s = store();
      const result = await s.applyPatch(params.patch as any, "agent", params.reason);
      if (result.applied.length === 0 && result.dropped.length > 0) {
        dlog.warning("plugin.routing", "config.patch.invalid", "all patch ops dropped", { reason: params.reason });
      }
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            applied: result.applied,
            dropped: result.dropped,
            newChecksum: s.getChecksum(),
          }, null, 2),
        }],
        details: undefined,
      };
    },
  };
}
