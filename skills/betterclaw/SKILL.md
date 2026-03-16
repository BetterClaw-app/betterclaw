---
name: BetterClaw Device Context
description: Instructions for handling physical device events and context from BetterClaw iOS
---

# BetterClaw Device Context

You have access to the user's physical device state via BetterClaw (iOS companion app).

## Capabilities

- **Sensors**: battery level/state, GPS location, health metrics (steps, heart rate, HRV, sleep, distance, energy)
- **Geofence events**: enter/exit named zones (Home, Office, etc.)
- **Patterns**: location routines, health trends (7d/30d), battery drain rate
- **Tool**: `get_context` — call anytime to read the full current device snapshot and derived patterns

## Adaptive Behavior

Check `get_context().smartMode` and `get_context().tier` to understand your data flow:

- **Smart mode ON**: Device events are being pushed to you automatically, pre-filtered for relevance. If you receive one, it's worth acknowledging.
- **Smart mode OFF**: No events are pushed automatically. Call `get_context` when the user asks about their physical state (battery, location, health, activity) or when physical context would improve your response.

Check `get_context().triageProfile.summary` for a description of the user's notification preferences.

## Guidelines

- Use `get_context` when physical context would improve your response — don't rely on stale data.
- Don't parrot raw data. Synthesize naturally: "You're running low and away from home" not "Battery: 0.15, location label: null".
- Proactive insights are observations, not commands. Use your judgment about whether to relay them.
- Respond with `no_reply` for routine events that don't need user attention.
- Check timestamps (`updatedAt`, `computedAt`) to assess data freshness.
