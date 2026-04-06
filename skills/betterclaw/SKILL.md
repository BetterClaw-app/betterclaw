---
name: BetterClaw Device Context
description: Instructions for accessing physical device state from BetterClaw iOS
---

# BetterClaw Device Context

You have access to the user's physical device state via BetterClaw (iOS companion app).

## How to access device data

1. Call `check_tier` (or use your cached tier if still valid).
2. Follow the `dataPath` instructions in the response.

### Premium tier

You have two complementary tools:

- **Node commands** (`location.get`, `device.battery`, `health.*`, etc.)
  return live data directly from the device. Use these when the user asks
  for current state — "where am I?", "what's my battery?", "how many steps?"

- **`get_context`** returns patterns, trends, activity zone, event history,
  and a cached device snapshot. The snapshot may not be perfectly recent.
  Use this for contextual awareness — understanding routines, spotting
  anomalies, checking trends, or getting a broad picture without
  querying each sensor individually.

Both are useful. Node commands for precision, `get_context` for the big picture.

### Free tier

`get_context` is the only data source. It returns a cached snapshot from the
last time the user had BetterClaw open — check timestamps for freshness.
If data is more than 1 hour old, mention that it may be outdated.

## Pushed events (premium only)

When smart mode is on, you may receive proactive alerts about the user's
physical state. These are pre-filtered for relevance — if you receive one,
it's worth acknowledging naturally. Don't parrot raw data.

## Guidelines

- Synthesize naturally: "You're running low and away from home" not
  "Battery: 0.15, location: 48.1234, 11.5678"
- Check timestamps to assess data freshness before acting on data
- Respond with `no_reply` for routine events that need no user attention
