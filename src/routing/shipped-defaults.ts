// src/routing/shipped-defaults.ts
import type { RoutingRules } from "./types.js";

/** Default rules shipped on first install. Aggressive "notify" defaults so the
 * learner has reactions to tune against during the first week. */
export function shippedDefaults(): RoutingRules {
  return {
    version: 1,
    quietHours: { start: "23:00", end: "07:00", tz: "auto" },
    rules: [
      { id: "geofence-enter-default",
        match: { source: "geofence.triggered", type: "enter" },
        action: "notify", explicit: false, cooldownMin: 60 },

      { id: "geofence-exit-default",
        match: { source: "geofence.triggered", type: "exit" },
        action: "notify", explicit: false, cooldownMin: 60 },

      { id: "default-drop", match: "*", action: "drop", explicit: true },
    ],
  };
}
