# BetterClaw Plugin Logging Schema

> **Generated from `src/redactor.ts` MANIFEST. Do not edit by hand.** Run `pnpm schema:gen` to regenerate.

**Manifest version:** 1

## Conventions

- Source name: `^plugin\.[a-z][a-z0-9]*(\.[a-z0-9]+)*$`
- Event name: `^[a-z][a-z0-9]*(\.[a-z0-9]+)*$`
- Data keys: camelCase; JSON-legal scalars only. The `error.*` dotted keys are a named carve-out emitted by `errorFields()`.
- Levels: `debug / info / notice / warning / error / critical`. Plugin emits 4 today; `notice` and `critical` are reserved slots.
- Timestamps: Unix seconds as float (matches iOS `TimeInterval`).
- **Fields not redacted:** `timestamp`, `level`, `source`, `event`, and `message` pass through unmodified. Consequence: `message` MUST be a static string literal at the call site — the schema lint enforces this. All dynamic content must go in `data` under a declared key.

## Sources

### `plugin.context` — export category `health` — **field-level category mapping enabled**

| event | level | required data |
|---|---|---|
| `error` | `error` | — |
| `info` | `info` | — |
| `warn` | `warning` | — |

### `plugin.events` — export category `lifecycle`

| event | level | required data |
|---|---|---|
| `error` | `error` | — |
| `info` | `info` | — |
| `warn` | `warning` | — |

### `plugin.filter` — export category `lifecycle`

| event | level | required data |
|---|---|---|
| `error` | `error` | — |
| `info` | `info` | — |
| `warn` | `warning` | — |

### `plugin.learner` — export category `lifecycle`

| event | level | required data |
|---|---|---|
| `learner.completed` | `info` | `durationMs` |
| `learner.failed` | `error` | — |
| `learner.started` | `info` | `eventsCount`, `reactionsCount`, `hasMemory`, `hasPreviousProfile` |
| `parse.failed` | `warning` | — |
| `profile.updated` | `info` | `interruptionTolerance` |

### `plugin.patterns` — export category `health` — **field-level category mapping enabled**

| event | level | required data |
|---|---|---|
| `compute.completed` | `info` | `eventsProcessed` |
| `error` | `error` | — |
| `info` | `info` | — |
| `warn` | `warning` | — |

### `plugin.pipeline` — export category `lifecycle`

| event | level | required data |
|---|---|---|
| `dedup.checked` | `debug` | `subscriptionId`, `currentLevel`, `lastPushedLevel`, `deduplicated` |
| `event.blocked` | `info` | `subscriptionId` |
| `event.error` | `error` | — |
| `event.free.stored` | `info` | `subscriptionId` |
| `event.notified` | `info` | `subscriptionId` |
| `event.pushed` | `info` | `subscriptionId` |
| `event.received` | `info` | `subscriptionId`, `source` |
| `notify.channel.unknown` | `warning` | `subscriptionId` |
| `push.decided` | `info` | `subscriptionId`, `decision` |
| `push.failed` | `error` | `subscriptionId` |
| `push.sent` | `info` | `subscriptionId` |

### `plugin.reactions` — export category `subscriptions`

| event | level | required data |
|---|---|---|
| `classified` | `info` | `subscriptionId`, `status` |
| `classified.error` | `error` | `subscriptionId` |
| `error` | `error` | — |
| `info` | `info` | — |
| `scan.completed` | `info` | `classified`, `skipped` |
| `scan.empty` | `debug` | — |
| `scan.error` | `error` | — |
| `scan.failed` | `error` | — |
| `scan.skipped` | `info` | `subscriptionId`, `pushedAt` |
| `scan.started` | `info` | `pendingCount` |
| `warn` | `warning` | — |

### `plugin.routing` — export category `lifecycle`

| event | level | required data |
|---|---|---|
| `autorule.failed` | `error` | — |
| `autorule.inserted` | `info` | `ruleId` |
| `config.bootstrapped` | `info` | — |
| `config.load.error` | `error` | — |
| `config.manual.edit.detected` | `info` | — |
| `config.patch.invalid` | `warning` | — |

### `plugin.rpc` — export category `lifecycle`

| event | level | required data |
|---|---|---|
| `config.applied` | `info` | `changedFields` |
| `config.error` | `error` | — |
| `context.error` | `error` | — |
| `context.served` | `info` | `tier` |
| `event.error` | `error` | — |
| `learn.error` | `error` | — |
| `learn.triggered` | `info` | — |
| `logs.error` | `error` | — |
| `ping.received` | `info` | — |
| `snapshot.applied` | `info` | `fieldCount` |
| `snapshot.error` | `error` | — |

### `plugin.service` — export category `lifecycle`

| event | level | required data |
|---|---|---|
| `error` | `error` | — |
| `info` | `info` | — |
| `init.complete` | `info` | `durationMs` |
| `init.phase` | `info` | `phase`, `success` |
| `loaded` | `info` | — |
| `started` | `info` | — |
| `stopped` | `info` | — |
| `warn` | `warning` | — |

### `plugin.triage` — export category `lifecycle`

| event | level | required data |
|---|---|---|
| `triage.called` | `info` | `subscriptionId`, `model` |
| `triage.fallback` | `error` | `subscriptionId`, `fallbackAction` |
| `triage.http.error` | `warning` | `status` |
| `triage.result` | `info` | `subscriptionId`, `decision` |

## Export categories

Each category is a boolean in `ExportSettings`. Disabling a category drops all entries from sources mapped to it (field-level implications still apply per-field).

| category | sources |
|---|---|
| `connection` | — |
| `heartbeat` | — |
| `commands` | — |
| `dns` | — |
| `lifecycle` | `plugin.events`, `plugin.filter`, `plugin.learner`, `plugin.pipeline`, `plugin.routing`, `plugin.rpc`, `plugin.service`, `plugin.triage` |
| `battery` | — |
| `subscriptions` | `plugin.reactions` |
| `health` | `plugin.context`, `plugin.patterns` |
| `location` | — |
| `geofence` | — |

## Redaction manifest

| key | strategy |
|---|---|
| `accessToken` | `drop` |
| `appVersion` | `allowPlain` |
| `bearerToken` | `drop` |
| `buildNumber` | `allowPlain` |
| `calories` | `drop` |
| `changedFields` | `allowPlain` |
| `classified` | `allowPlain` |
| `command` | `allowPlain` |
| `commandName` | `allowPlain` |
| `commandType` | `allowPlain` |
| `connectionId` | `hmacId` |
| `coordinate` | `drop` |
| `coordinates` | `drop` |
| `correlationId` | `hmacId` |
| `currentLevel` | `allowPlain` |
| `cycleId` | `hmacId` |
| `decision` | `allowPlain` |
| `deduplicated` | `allowPlain` |
| `description` | `drop` |
| `deviceId` | `hmacId` |
| `deviceModel` | `allowPlain` |
| `deviceToken` | `drop` |
| `durationMs` | `allowPlain` |
| `endpoint` | `hmacHost` |
| `entitlements` | `allowPlain` |
| `error.authCanRetryWithDeviceToken` | `allowPlain` |
| `error.authDetailCode` | `allowPlain` |
| `error.authMessage` | `allowPlain` |
| `error.authRecommendedNextStep` | `allowPlain` |
| `error.cause` | `allowPlain` |
| `error.code` | `allowPlain` |
| `error.description` | `allowPlain` |
| `error.domain` | `allowPlain` |
| `error.failingURL` | `hmacUrlHost` |
| `error.message` | `allowPlain` |
| `error.stack` | `allowPlain` |
| `error.type` | `allowPlain` |
| `error.underlyingCode` | `allowPlain` |
| `error.underlyingDomain` | `allowPlain` |
| `eventsCount` | `allowPlain` |
| `eventsProcessed` | `allowPlain` |
| `failingURL` | `hmacUrlHost` |
| `fallbackAction` | `allowPlain` |
| `fieldCount` | `allowPlain` |
| `filePath` | `drop` |
| `gateway` | `hmacHost` |
| `geofenceCoords` | `drop` |
| `geofenceId` | `hmacId` |
| `hasMemory` | `allowPlain` |
| `hasPreviousProfile` | `allowPlain` |
| `heartRate` | `drop` |
| `host` | `hmacHost` |
| `interruptionTolerance` | `allowPlain` |
| `ip` | `hmacHost` |
| `label` | `hmacId` |
| `lastPushedLevel` | `allowPlain` |
| `lat` | `drop` |
| `latitude` | `drop` |
| `legacyKey` | `drop` |
| `locale` | `drop` |
| `lon` | `drop` |
| `longitude` | `drop` |
| `model` | `allowPlain` |
| `nodeConnected` | `allowPlain` |
| `nodeId` | `hmacId` |
| `password` | `drop` |
| `path` | `drop` |
| `pendingCount` | `allowPlain` |
| `phase` | `allowPlain` |
| `pushedAt` | `allowPlain` |
| `reactionsCount` | `allowPlain` |
| `refreshToken` | `drop` |
| `regionId` | `hmacId` |
| `regions` | `drop` |
| `runId` | `hmacId` |
| `serverId` | `hmacId` |
| `serverName` | `hmacHost` |
| `sessionId` | `hmacId` |
| `skipped` | `allowPlain` |
| `smartMode` | `allowPlain` |
| `source` | `hmacId` |
| `status` | `allowPlain` |
| `steps` | `drop` |
| `subscriptionId` | `hmacId` |
| `success` | `allowPlain` |
| `systemVersion` | `allowPlain` |
| `target` | `hmacHost` |
| `tier` | `allowPlain` |
| `timezone` | `drop` |
| `tokenSuffix` | `drop` |
| `underlyingDescription` | `drop` |
| `upstream` | `hmacUrlHost` |
| `url` | `hmacUrlHost` |
| `version` | `allowPlain` |
| `zoneName` | `hmacId` |

## Field-level category implications

| key | implies category |
|---|---|
| `calories` | `health` |
| `coordinate` | `location` |
| `coordinates` | `location` |
| `geofenceCoords` | `geofence` |
| `geofenceId` | `geofence` |
| `heartRate` | `health` |
| `lat` | `location` |
| `latitude` | `location` |
| `lon` | `location` |
| `longitude` | `location` |
| `steps` | `health` |
| `zoneName` | `geofence` |
