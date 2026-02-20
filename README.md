# @betterclaw-app/betterclaw

OpenClaw plugin that adds intelligent event filtering, context tracking, pattern recognition, and proactive triggers for the [BetterClaw](https://github.com/BetterClaw-app) iOS companion app.

## Install

```bash
openclaw plugins install @betterclaw-app/betterclaw
```

## What it does

The plugin sits between the BetterClaw iOS app and the OpenClaw AI agent. Instead of dumping every device event into the agent's conversation, it:

- **Filters** events with a rules engine (dedup, cooldowns, budget limits)
- **Triages** ambiguous events with a cheap LLM call (configurable model)
- **Tracks context** — battery, location zones, health metrics, activity state
- **Computes patterns** — location routines, health trends, event stats (every 6h)
- **Fires proactive insights** — low battery away from home, unusual inactivity, sleep deficit, routine deviations, weekly health digest

Events that pass the filter are injected into the agent's main session. The agent decides whether to notify the user.

## Configuration

Set via `openclaw.json` under `plugins.entries.betterclaw.config`:

| Key | Default | Description |
|-----|---------|-------------|
| `llmModel` | `openai/gpt-4o-mini` | Model for ambiguous event triage |
| `pushBudgetPerDay` | `10` | Max events pushed to agent per day |
| `patternWindowDays` | `14` | Days of history for pattern computation |
| `proactiveEnabled` | `true` | Enable proactive insight triggers |

## Agent tool

The plugin registers a `get_context` tool the agent can call to read the current device state (battery, location, health, activity, patterns).

## Commands

- `/bc` — Show current device context snapshot in chat

## Compatibility

| Plugin | iOS App | OpenClaw |
|--------|---------|----------|
| 1.x | 1.x+ | 2025.12+ |

## License

[AGPL-3.0](LICENSE)
