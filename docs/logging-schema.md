# BetterClaw Plugin Logging Schema

> **Generated from `src/redactor.ts` MANIFEST. Do not edit by hand.** Run `pnpm schema:gen` to regenerate.

**Manifest version:** 1

## Conventions

- Source name: `^plugin\.[a-z][a-z0-9]*(\.[a-z0-9]+)*$`
- Event name: `^[a-z][a-z0-9]*(\.[a-z0-9]+)*$`
- Data keys: camelCase; JSON-legal scalars only. The `error.*` dotted keys are a named carve-out emitted by `errorFields()`.
- Levels: `debug / info / notice / warning / error / critical`. Plugin emits 4 today; `notice` and `critical` are reserved slots.
- Timestamps: Unix seconds as float (matches iOS `TimeInterval`).

## Sources

### `plugin.calibration` — export category `lifecycle`

| event | level | required data |
|---|---|---|
| `calibration.error` | `warning` | — |
| `calibration.skipped` | `info` | — |
| `calibration.started` | `info` | — |

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

### `plugin.patterns` — export category `health` — **field-level category mapping enabled**

| event | level | required data |
|---|---|---|
| `error` | `error` | — |
| `info` | `info` | — |
| `warn` | `warning` | — |

### `plugin.pipeline` — export category `lifecycle`

| event | level | required data |
|---|---|---|
| `event.error` | `error` | — |

### `plugin.reactions` — export category `subscriptions`

| event | level | required data |
|---|---|---|
| `error` | `error` | — |
| `info` | `info` | — |
| `scan.failed` | `error` | — |
| `warn` | `warning` | — |

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

## Redaction manifest

| key | strategy |
|---|---|
| `accessToken` | `drop` |
| `appVersion` | `allowPlain` |
| `bearerToken` | `drop` |
| `buildNumber` | `allowPlain` |
| `calories` | `drop` |
| `changedFields` | `allowPlain` |
| `command` | `allowPlain` |
| `commandName` | `allowPlain` |
| `commandType` | `allowPlain` |
| `connectionId` | `hmacId` |
| `coordinate` | `drop` |
| `coordinates` | `drop` |
| `correlationId` | `hmacId` |
| `cycleId` | `hmacId` |
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
| `failingURL` | `hmacUrlHost` |
| `fieldCount` | `allowPlain` |
| `filePath` | `drop` |
| `gateway` | `hmacHost` |
| `geofenceCoords` | `drop` |
| `geofenceId` | `hmacId` |
| `heartRate` | `drop` |
| `host` | `hmacHost` |
| `ip` | `hmacHost` |
| `label` | `hmacId` |
| `lat` | `drop` |
| `latitude` | `drop` |
| `legacyKey` | `drop` |
| `locale` | `drop` |
| `lon` | `drop` |
| `longitude` | `drop` |
| `nodeConnected` | `allowPlain` |
| `nodeId` | `hmacId` |
| `password` | `drop` |
| `path` | `drop` |
| `phase` | `allowPlain` |
| `refreshToken` | `drop` |
| `regionId` | `hmacId` |
| `regions` | `drop` |
| `runId` | `hmacId` |
| `serverId` | `hmacId` |
| `serverName` | `hmacHost` |
| `sessionId` | `hmacId` |
| `smartMode` | `allowPlain` |
| `steps` | `drop` |
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
