<p align="center">
  <img src="banner.png" alt="BetterClaw" width="100%" />
</p>

<p align="center">
  <em>OpenClaw plugin for the BetterClaw iOS app</em>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@betterclaw-app/betterclaw"><img src="https://img.shields.io/npm/v/@betterclaw-app/betterclaw?style=flat-square&color=blue" alt="npm version" /></a>
  <a href="https://github.com/BetterClaw-app/betterclaw/blob/main/LICENSE"><img src="https://img.shields.io/github/license/BetterClaw-app/betterclaw?style=flat-square" alt="license" /></a>
  <a href="https://www.npmjs.com/package/@betterclaw-app/betterclaw"><img src="https://img.shields.io/npm/dm/@betterclaw-app/betterclaw?style=flat-square&color=green" alt="downloads" /></a>
  <a href="https://openclaw.dev"><img src="https://img.shields.io/badge/platform-OpenClaw-orange?style=flat-square" alt="OpenClaw" /></a>
</p>

---

## What is this?

This is the server-side plugin for [BetterClaw](https://github.com/BetterClaw-app/BetterClaw-ios), an iOS app that connects your iPhone's sensors to your [OpenClaw](https://openclaw.dev) AI agent. The app streams device events (location, battery, health, geofences) to your gateway — this plugin decides what to do with them.

The plugin is the **sole event gateway** for all tiers. Smart mode controls filtering depth: OFF = passive context store, ON = full pipeline with rules, LLM triage, and proactive insights.

```
  BetterClaw iOS App          This Plugin (on gateway)              Agent
 ──────────────────          ────────────────────────             ────────
                                       │
  battery ──────▶  ┌───────────────────┼───────────────────┐
  location ─────▶  │  Rules Engine     │  Context Store     │
  health ───────▶  │  LLM Triage       │  Pattern Engine    │ ──▶  filtered events
  geofence ─────▶  │  Daily Learner    │  Proactive Triggers│      + full context
                   └───────────────────┼───────────────────┘
                                       │
                                 proactive insights
                              (low battery + away from
                               home, sleep deficit, etc.)
```

## Features

- **Tier-Aware Smart Mode** — Smart mode ON = full pipeline (rules → triage → push). Smart mode OFF = passive store (context updated, no filtering or pushing). Synced via periodic heartbeat from iOS.
- **Two-Layer LLM Triage** — Daily learner builds a personalized triage profile from OpenClaw memory summaries + event reactions. Per-event cheap LLM call with structured output for ambiguous events.
- **Smart Filtering** — Per-source dedup, cooldown windows, and a configurable daily push budget prevent event spam
- **Device Context** — Rolling state snapshot with per-field timestamps: battery, GPS, zone occupancy, health metrics, activity classification
- **Pattern Recognition** — Daily analysis computes location routines, health trends (7d/30d baselines), and event frequency stats
- **Proactive Insights** — Combined-signal triggers: low battery away from home, unusual inactivity, sleep deficit, routine deviations, weekly digest
- **Per-Device Config** — iOS app can override push budget and proactive settings at runtime via RPC
- **Agent Tool** — `get_context` tool lets your agent read the full device snapshot, tier, smart mode status, and triage profile on demand
- **CLI Setup** — `openclaw betterclaw setup` configures gateway allowedCommands automatically

## Requirements

- [BetterClaw iOS app](https://github.com/BetterClaw-app/BetterClaw-ios) installed and connected to your gateway
- [OpenClaw](https://openclaw.dev) gateway (2025.12+)

## Install

```bash
openclaw plugins install @betterclaw-app/betterclaw
openclaw betterclaw setup   # configures gateway allowedCommands
```

## Configure

Add to your `openclaw.json`:

```jsonc
{
  "plugins": {
    "entries": {
      "betterclaw": {
        "enabled": true,
        "config": {
          "triageModel": "openai/gpt-4o-mini",
          "pushBudgetPerDay": 10,
          "patternWindowDays": 14,
          "proactiveEnabled": true,
          "analysisHour": 5
        }
      }
    }
  }
}
```

All config keys are optional — defaults are shown above.

### Config Reference

| Key | Default | Description |
|-----|---------|-------------|
| `triageModel` | `openai/gpt-4o-mini` | Model for per-event triage (supports `provider/model` format) |
| `triageApiBase` | — | Optional base URL for OpenAI-compatible endpoint (e.g., Ollama) |
| `pushBudgetPerDay` | `10` | Max events forwarded to the agent per day |
| `patternWindowDays` | `14` | Days of event history used for pattern computation |
| `proactiveEnabled` | `true` | Enable proactive combined-signal insights |
| `analysisHour` | `5` | Hour (0-23, system timezone) for daily pattern + learner analysis |

> **Migration:** `llmModel` still works as a deprecated alias for `triageModel`.

## How It Works

### Event Pipeline

Every device event from the BetterClaw app goes through the plugin:

1. **Context Update** — Device context store is always updated with the latest sensor data.
2. **Smart Mode Check** — If smart mode is OFF, the event is stored and processing stops. If ON, continues.
3. **Rules Engine** — Checks dedup, cooldown timers, and daily budget. Critical events (geofence, low battery) always push. Obvious spam is dropped.
4. **LLM Triage** — Ambiguous events get a cheap LLM call with the personalized triage profile for a push/drop decision.
5. **Agent Injection** — Events that pass are injected into the agent's main session with formatted context.

### Background Services

- **Pattern Engine + Daily Learner** (daily at `analysisHour`) — Computes location routines, health trends, event stats. Then runs a subagent turn to build a personalized triage profile from OpenClaw memory summaries and notification reaction data.
- **Proactive Engine** (hourly) — Evaluates combined-signal conditions and fires insights when thresholds are met.

### Gateway RPCs

| RPC | Direction | Purpose |
|-----|-----------|---------|
| `betterclaw.event` | iOS → plugin | Send a device event for processing |
| `betterclaw.ping` | iOS → plugin | Heartbeat: sync tier + smartMode, get budget info |
| `betterclaw.config` | iOS → plugin | Per-device settings override |
| `betterclaw.context` | iOS → plugin | Full context for iOS Context tab |
| `betterclaw.snapshot` | iOS → plugin | Bulk device state catch-up |

## Commands

| Command | Description |
|---------|-------------|
| `/bc` | Show current device context snapshot in chat |

## Compatibility

| Plugin | BetterClaw iOS | OpenClaw |
|--------|----------------|----------|
| 2.x    | 2.x+           | 2025.12+ |
| 1.x    | 1.x            | 2025.12+ |

## License

[AGPL-3.0](LICENSE) — Free to use, modify, and self-host. Derivative works must remain open source.
