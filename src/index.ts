import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginConfig, DeviceConfig } from "./types.js";
import { errorMessage } from "./types.js";
import { errorFields } from "./errors.js";
import { initDiagnosticLogger } from "./diagnostic-logger.js";
import { handleLogsRpc, resolveAnonymizationKey, type LogsRpcParams } from "./logs-rpc.js";
import { randomBytes } from "node:crypto";
import { ContextManager } from "./context.js";
import { createGetContextTool } from "./tools/get-context.js";
import { EventLog } from "./events.js";
import { RulesEngine } from "./filter.js";
import { PatternEngine } from "./patterns.js";
import { processEvent } from "./pipeline.js";
import type { PipelineDeps } from "./pipeline.js";
import { BETTERCLAW_COMMANDS, BETTERCLAW_TOOLS, mergeAllowCommands, mergeAlsoAllow } from "./cli.js";
import { storeJwt } from "./jwt.js";
import { runLearner } from "./learner.js";
import { ReactionTracker } from "./reactions.js";
import { createCheckTierTool } from "./tools/check-tier.js";
import { scanPendingReactions } from "./reaction-scanner.js";
import { RoutingConfigStore } from "./routing/config-store.js";
import { AuditLog } from "./routing/audit-log.js";
import { createEditRoutingRulesTool } from "./tools/edit-routing-rules.js";
import * as os from "node:os";
import * as path from "node:path";

export type { PluginConfig } from "./types.js";

const DEFAULT_COOLDOWNS: Record<string, number> = {
  "default.battery-low": 3600,
  "default.battery-critical": 1800,
  "default.daily-health": 82800,
  "default.geofence": 300,
};

const DEFAULT_CONFIG: PluginConfig = {
  triageModel: "openai/gpt-4o-mini",
  triageApiBase: undefined,
  pushBudgetPerDay: 10,
  patternWindowDays: 14,
  proactiveEnabled: true,
  analysisHour: 5,
  deduplicationCooldowns: DEFAULT_COOLDOWNS,
  defaultCooldown: 1800,
};

export function resolveConfig(raw: Record<string, unknown> | undefined): PluginConfig {
  const cfg = raw ?? {};
  return {
    triageModel: (cfg.triageModel as string) ?? (cfg.llmModel as string) ?? "openai/gpt-4o-mini",
    triageApiBase: (cfg.triageApiBase as string) ?? undefined,
    pushBudgetPerDay: typeof cfg.pushBudgetPerDay === "number" && cfg.pushBudgetPerDay > 0 ? cfg.pushBudgetPerDay : 10,
    patternWindowDays: typeof cfg.patternWindowDays === "number" && cfg.patternWindowDays > 0 ? cfg.patternWindowDays : 14,
    proactiveEnabled: typeof cfg.proactiveEnabled === "boolean" ? cfg.proactiveEnabled : true,
    analysisHour: typeof cfg.analysisHour === "number" ? Math.max(0, Math.min(23, cfg.analysisHour)) : 5,
    deduplicationCooldowns: {
      ...DEFAULT_COOLDOWNS,
      ...(typeof cfg.deduplicationCooldowns === "object" && cfg.deduplicationCooldowns !== null
        ? cfg.deduplicationCooldowns as Record<string, number>
        : {}),
    },
    defaultCooldown: typeof cfg.defaultCooldown === "number" && cfg.defaultCooldown > 0 ? cfg.defaultCooldown : 1800,
  };
}

export default {
  id: "betterclaw",
  name: "BetterClaw Context",

  register(api: OpenClawPluginApi) {
    const config = resolveConfig(api.pluginConfig as Record<string, unknown> | undefined);
    const stateDir = api.runtime.state.resolveStateDir();
    const diagnosticLogger = initDiagnosticLogger(path.join(stateDir, "logs"), api.logger);
    const redactionKey = randomBytes(32);

    diagnosticLogger.info("plugin.service", "loaded", "plugin loaded", { model: config.triageModel, budget: config.pushBudgetPerDay });

    // Context manager (load synchronously — file read deferred to first access)
    const ctxManager = new ContextManager(stateDir, diagnosticLogger.scoped("plugin.context"));

    // Event log, rules engine, reaction tracker
    const eventLog = new EventLog(stateDir, diagnosticLogger.scoped("plugin.events"));
    const rules = new RulesEngine(config.pushBudgetPerDay, config.deduplicationCooldowns, config.defaultCooldown);
    const reactionTracker = new ReactionTracker(stateDir, diagnosticLogger.scoped("plugin.reactions"));

    // Routing config store + audit log — loaded async
    const auditLog = new AuditLog(stateDir);
    let routingStore: RoutingConfigStore;

    // Pipeline dependencies — routing filled in after initPromise resolves
    const pipelineDeps: PipelineDeps = {
      api,
      config,
      context: ctxManager,
      events: eventLog,
      rules,
      reactions: reactionTracker,
      stateDir,
      routing: undefined as unknown as RoutingConfigStore,
      audit: auditLog,
    };

    const pluginVersion = "2.0.0";

    // Track whether async init has completed
    let initialized = false;
    let learnerRunning = false;
    const initStart = Date.now();
    const initPromise = (async () => {
      try {
        await ctxManager.load();
        initialized = true;
        diagnosticLogger.info("plugin.service", "init.phase", "context loaded", { phase: "context", success: true });
      } catch (err) {
        diagnosticLogger.error("plugin.service", "init.phase", "context init failed", { phase: "context", success: false, ...errorFields(err) });
      }
      try {
        await reactionTracker.load();
        diagnosticLogger.info("plugin.service", "init.phase", "reactions loaded", { phase: "reactions", success: true });
      } catch (err) {
        diagnosticLogger.warning("plugin.service", "init.phase", "reaction tracker load failed", { phase: "reactions", success: false, ...errorFields(err) });
      }
      try {
        routingStore = await RoutingConfigStore.load(stateDir, auditLog);
        pipelineDeps.routing = routingStore;
        diagnosticLogger.info("plugin.service", "init.phase", "routing loaded", { phase: "routing", success: true });
      } catch (err) {
        diagnosticLogger.error("plugin.service", "init.phase", "routing init failed", { phase: "routing", success: false, ...errorFields(err) });
      }
      if (initialized) {
        try {
          const recentEvents = await eventLog.readSince(Date.now() / 1000 - 86400);
          rules.restoreCooldowns(
            recentEvents
              .filter((e) => e.decision === "push")
              .map((e) => ({ subscriptionId: e.event.subscriptionId, firedAt: e.event.firedAt, data: e.event.data })),
          );
          diagnosticLogger.info("plugin.service", "init.complete", "async init complete", { durationMs: Date.now() - initStart });
        } catch (err) {
          diagnosticLogger.error("plugin.service", "init.phase", "cooldown restore failed", { phase: "cooldowns", success: false, ...errorFields(err) });
        }
      }
    })();

    // Ping health check
    api.registerGatewayMethod("betterclaw.ping", async ({ params, respond, context }) => {
      const validTiers: Array<"free" | "premium"> = ["free", "premium"];
      const rawTier = (params as Record<string, unknown>)?.tier as string;
      const tier = validTiers.includes(rawTier as any) ? (rawTier as "free" | "premium") : "free";
      const smartMode = (params as Record<string, unknown>)?.smartMode === true;
      const tz = typeof (params as Record<string, unknown>)?.tz === "string"
        ? (params as Record<string, unknown>).tz as string
        : undefined;

      const jwt = (params as Record<string, unknown>)?.jwt as string | undefined;
      if (jwt) {
        const payload = await storeJwt(jwt);
        if (payload) {
          diagnosticLogger.info("plugin.rpc", "ping.received", "JWT verified", { tier, smartMode, entitlements: payload.ent });
        } else {
          diagnosticLogger.warning("plugin.rpc", "ping.received", "JWT verification failed", { tier, smartMode });
        }
      } else {
        diagnosticLogger.info("plugin.rpc", "ping.received", "device ping", { tier, smartMode, nodeConnected: context.hasConnectedMobileNode() });
      }

      ctxManager.setRuntimeState({ tier, smartMode, ...(tz ? { tz } : {}) });

      const meta = ctxManager.get().meta;
      const effectiveBudget = ctxManager.getDeviceConfig().pushBudgetPerDay ?? config.pushBudgetPerDay;
      respond(true, {
        ok: true,
        version: pluginVersion,
        initialized,
        pushesToday: meta.pushesToday,
        budgetRemaining: Math.max(0, effectiveBudget - meta.pushesToday),
        nodeConnected: context.hasConnectedMobileNode(),
      });
    });

    // Config RPC — update per-device settings at runtime
    api.registerGatewayMethod("betterclaw.config", async ({ params, respond }) => {
      // Note: config save runs outside the event queue. Concurrent saves with processEvent
      // could race on context.json. Accepted risk — config changes are user-initiated and infrequent.
      try {
        const update = params as Record<string, unknown>;
        const deviceConfig: DeviceConfig = {};

        if (typeof update.pushBudgetPerDay === "number") {
          deviceConfig.pushBudgetPerDay = update.pushBudgetPerDay;
        }
        if (typeof update.proactiveEnabled === "boolean") {
          deviceConfig.proactiveEnabled = update.proactiveEnabled;
        }

        ctxManager.setDeviceConfig(deviceConfig);
        await ctxManager.save();
        diagnosticLogger.info("plugin.rpc", "config.applied", "config updated", { changedFields: Object.keys(deviceConfig) });
        respond(true, { applied: true });
      } catch (err) {
        diagnosticLogger.error("plugin.rpc", "config.error", "config RPC failed", errorFields(err));
        respond(false, undefined, { code: "INTERNAL_ERROR", message: "config update failed" });
      }
    });

    // Context RPC — returns activity, trends, and recent decisions for iOS Context tab
    api.registerGatewayMethod("betterclaw.context", async ({ respond }) => {
      try {
        if (!initialized) await initPromise;

        const state = ctxManager.get();
        const runtime = ctxManager.getRuntimeState();
        const timestamps = {
          battery: ctxManager.getTimestamp("battery") ?? null,
          location: ctxManager.getTimestamp("location") ?? null,
          health: ctxManager.getTimestamp("health") ?? null,
          activity: ctxManager.getTimestamp("activity") ?? null,
          lastSnapshot: ctxManager.getTimestamp("lastSnapshot") ?? null,
        };
        const patterns = await ctxManager.readPatterns();
        const recentEntries = await eventLog.readRecent(20);

        const activity = {
          currentZone: state.activity.currentZone,
          zoneEnteredAt: state.activity.zoneEnteredAt,
          lastTransition: state.activity.lastTransition,
          isStationary: state.activity.isStationary,
          stationarySince: state.activity.stationarySince,
        };

        const trends = patterns
          ? {
              stepsAvg7d: patterns.healthTrends.stepsAvg7d,
              stepsTrend: patterns.healthTrends.stepsTrend,
              sleepAvg7d: patterns.healthTrends.sleepAvg7d,
              sleepTrend: patterns.healthTrends.sleepTrend,
              restingHrAvg7d: patterns.healthTrends.restingHrAvg7d,
              restingHrTrend: patterns.healthTrends.restingHrTrend,
              eventsPerDay7d: patterns.eventStats.eventsPerDay7d,
              pushesPerDay7d: patterns.eventStats.pushesPerDay7d,
              dropRate7d: patterns.eventStats.dropRate7d,
            }
          : null;

        const decisions = recentEntries.map((e) => ({
          source: e.event.source,
          title: e.event.subscriptionId,
          decision: e.decision,
          reason: e.reason,
          timestamp: e.timestamp,
        }));

        const meta = {
          pushesToday: state.meta.pushesToday,
          pushBudgetPerDay: config.pushBudgetPerDay,
          eventsToday: state.meta.eventsToday,
          lastSnapshotAt: timestamps.lastSnapshot,
          lastAnalysisAt: patterns?.computedAt,
        };

        const routines = patterns
          ? {
              weekday: patterns.locationRoutines.weekday,
              weekend: patterns.locationRoutines.weekend,
            }
          : null;

        diagnosticLogger.info("plugin.rpc", "context.served", "context served", { tier: runtime.tier });
        respond(true, {
          tier: runtime.tier,
          smartMode: runtime.smartMode,
          activity,
          trends,
          decisions,
          meta,
          routines,
          timestamps,
        });
      } catch (err) {
        diagnosticLogger.error("plugin.rpc", "context.error", "context RPC failed", errorFields(err));
        respond(false, undefined, { code: "INTERNAL_ERROR", message: "context fetch failed" });
      }
    });

    // Learn RPC — trigger on-demand routing rule tuning
    api.registerGatewayMethod("betterclaw.learn", async ({ respond }) => {
      try {
        diagnosticLogger.info("plugin.rpc", "learn.triggered", "learn RPC triggered");
        if (!initialized) await initPromise;

        if (learnerRunning) {
          respond(true, { ok: false, error: "already-running" });
          return;
        }

        learnerRunning = true;
        try {
          await runLearner({
            stateDir,
            workspaceDir: path.join(os.homedir(), ".openclaw", "workspace"),
            context: ctxManager,
            events: eventLog,
            reactions: reactionTracker,
            api,
            routing: routingStore,
            audit: auditLog,
          });
          respond(true, { ok: true, summary: "learner tuned routing rules" });
        } finally {
          learnerRunning = false;
        }
      } catch (err) {
        learnerRunning = false;
        const msg = errorMessage(err);
        diagnosticLogger.error("plugin.rpc", "learn.error", "learn RPC failed", { ...errorFields(err) });
        respond(true, { ok: false, error: msg });
      }
    });

    // Snapshot RPC — bulk-apply device state for Smart Mode catch-up
    api.registerGatewayMethod("betterclaw.snapshot", async ({ params, respond }) => {
      try {
        if (!initialized) await initPromise;

        const snapshot = params as {
          battery?: { level: number; state: string; isLowPowerMode: boolean };
          location?: { latitude: number; longitude: number };
          health?: {
            stepsToday?: number; distanceMeters?: number; heartRateAvg?: number;
            restingHeartRate?: number; hrv?: number; activeEnergyKcal?: number;
            sleepDurationSeconds?: number;
          };
          geofence?: { type: string; zoneName: string; latitude: number; longitude: number };
        };

        ctxManager.applySnapshot(snapshot);
        await ctxManager.save();
        diagnosticLogger.info("plugin.rpc", "snapshot.applied", "snapshot applied", { fieldCount: Object.keys(snapshot).length });
        respond(true, { applied: true });
      } catch (err) {
        diagnosticLogger.error("plugin.rpc", "snapshot.error", "snapshot RPC failed", errorFields(err));
        respond(false, undefined, { code: "INTERNAL_ERROR", message: "snapshot apply failed" });
      }
    });

    // Diagnostic logs RPC — read structured log entries
    api.registerGatewayMethod("betterclaw.logs", async ({ params, respond }) => {
      try {
        const p = params as LogsRpcParams;
        if (!p.settings) {
          respond(false, undefined, { code: "MISSING_SETTINGS", message: "settings is required" });
          return;
        }
        const keyResult = resolveAnonymizationKey(p, redactionKey);
        if ("error" in keyResult) {
          respond(false, undefined, keyResult.error);
          return;
        }
        const result = await handleLogsRpc(
          { settings: p.settings, since: p.since, until: p.until, limit: p.limit, after: p.after },
          diagnosticLogger,
          keyResult.key,
        );
        respond(true, result);
      } catch (err) {
        // SECURITY: never include `params` in this log — anonymizationKey is
        // secret, and the raw params object carries it. errorFields() on
        // the error object alone is safe (it captures message/stack/.code only).
        diagnosticLogger.error("plugin.rpc", "logs.error", "logs RPC failed", errorFields(err));
        // Forward cursor-error discriminators so the client can distinguish
        // retriable (CURSOR_EXPIRED → restart pagination) from permanent
        // (INVALID_CURSOR → caller bug). Any other failure falls through to
        // the generic LOGS_ERROR envelope.
        const maybeCode = err instanceof Error
          ? (err as { code?: unknown }).code
          : undefined;
        const code = typeof maybeCode === "string" ? maybeCode : null;
        if (code === "INVALID_CURSOR" || code === "CURSOR_EXPIRED") {
          respond(false, undefined, { code, message: (err as Error).message });
          return;
        }
        respond(false, undefined, { code: "LOGS_ERROR", message: "logs RPC failed" });
      }
    });

    // Agent tools
    api.registerTool(createCheckTierTool(ctxManager));
    api.registerTool(createGetContextTool(ctxManager, stateDir));
    api.registerTool(createEditRoutingRulesTool(() => routingStore));

    // Auto-reply command
    api.registerCommand({
      name: "bc",
      description: "Show current BetterClaw device context snapshot",
      handler: () => {
        const state = ctxManager.get();
        const battery = state.device.battery;
        const loc = state.device.location;
        const health = state.device.health;
        const activity = state.activity;

        const lines: string[] = [];
        if (battery) {
          lines.push(`Battery: ${Math.round(battery.level * 100)}% (${battery.state})`);
        }
        if (loc) {
          lines.push(`Location: ${loc.label ?? `${loc.latitude.toFixed(4)}, ${loc.longitude.toFixed(4)}`}`);
        }
        if (activity.currentZone) {
          const since = activity.zoneEnteredAt
            ? ` since ${new Date(activity.zoneEnteredAt * 1000).toLocaleTimeString()}`
            : "";
          lines.push(`Zone: ${activity.currentZone}${since}`);
        }
        if (health?.stepsToday) {
          lines.push(`Steps: ${Math.round(health.stepsToday).toLocaleString()}`);
        }
        lines.push(`Events today: ${state.meta.eventsToday} | Pushes: ${state.meta.pushesToday}`);

        return { text: lines.join("\n") };
      },
    });

    // Sequential event queue — prevents budget races
    let eventQueue: Promise<void> = Promise.resolve();

    // Event intake RPC
    api.registerGatewayMethod("betterclaw.event", async ({ params, respond }) => {
      try {
        // Wait for init if still pending
        if (!initialized) await initPromise;

        const event = {
          subscriptionId: typeof params?.subscriptionId === "string" ? params.subscriptionId : "",
          source: typeof params?.source === "string" ? params.source : "",
          data: (params?.data && typeof params.data === "object" ? params.data : {}) as Record<string, number>,
          metadata: (params?.metadata && typeof params.metadata === "object"
            ? params.metadata
            : undefined) as Record<string, string> | undefined,
          firedAt: typeof params?.firedAt === "number" ? params.firedAt : Date.now() / 1000,
        };

        if (!event.subscriptionId || !event.source) {
          respond(false, undefined, { code: "INVALID_PARAMS", message: "subscriptionId and source required" });
          return;
        }

        respond(true, { accepted: true });

        // Sequential processing — prevents budget races
        eventQueue = eventQueue.then(() => processEvent(pipelineDeps, event)).catch((err) => {
          const msg = errorMessage(err);
          diagnosticLogger.error("plugin.pipeline", "event.error", "event processing failed", { ...errorFields(err) });
          eventLog.append({ event, decision: "error", reason: `processing error: ${msg}`, timestamp: Date.now() / 1000 });
        });
      } catch (err) {
        diagnosticLogger.error("plugin.rpc", "event.error", "event handler error", errorFields(err));
        respond(false, undefined, { code: "INTERNAL_ERROR", message: "event processing failed" });
      }
    });

    // Pattern engine
    const patternEngine = new PatternEngine(ctxManager, eventLog, config.patternWindowDays, diagnosticLogger.scoped("plugin.patterns"));

    // Background service
    api.registerService({
      id: "betterclaw-engine",
      start: () => {
        patternEngine.startSchedule(config.analysisHour, async () => {
          await diagnosticLogger.rotate();

          if (ctxManager.getRuntimeState().smartMode) {
            try {
              await scanPendingReactions({ reactions: reactionTracker, api });
            } catch (err) {
              diagnosticLogger.error("plugin.reactions", "scan.failed", "reaction scan failed", errorFields(err));
            }

            try {
              const learnerStart = Date.now();
              await runLearner({
                stateDir,
                workspaceDir: path.join(os.homedir(), ".openclaw", "workspace"),
                context: ctxManager,
                events: eventLog,
                reactions: reactionTracker,
                api,
                routing: routingStore,
                audit: auditLog,
              });
              diagnosticLogger.info("plugin.learner", "learner.completed", "daily learner completed", { durationMs: Date.now() - learnerStart });
            } catch (err) {
              diagnosticLogger.error("plugin.learner", "learner.failed", "daily learner failed", errorFields(err));
            }
          }
        });
        diagnosticLogger.info("plugin.service", "started", "background services started", { analysisHour: config.analysisHour });
      },
      stop: () => {
        patternEngine.stopSchedule();
        diagnosticLogger.info("plugin.service", "stopped", "background services stopped");
      },
    });

    // CLI setup command
    api.registerCli(
      ({ program }) => {
        const cmd = program.command("betterclaw").description("BetterClaw plugin management");

        cmd
          .command("setup")
          .description("Configure gateway allowedCommands and agent tools for BetterClaw")
          .option("--dry-run", "Preview changes without writing")
          .action(async (opts: { dryRun?: boolean }) => {
            try {
              const currentConfig = await api.runtime.config.loadConfig();
              const configObj = { ...currentConfig } as any;

              // 1. Merge node allowedCommands
              const existingCmds: string[] = configObj?.gateway?.nodes?.allowCommands ?? [];
              const mergedCmds = mergeAllowCommands(existingCmds, BETTERCLAW_COMMANDS);
              const addedCmds = mergedCmds.length - existingCmds.length;

              // 2. Merge tools.alsoAllow for plugin tools
              configObj.tools = configObj.tools ?? {};
              const existingAllow: string[] = configObj.tools.alsoAllow ?? [];
              const mergedAllow = mergeAlsoAllow(existingAllow, BETTERCLAW_TOOLS);
              const addedTools = mergedAllow.length - existingAllow.length;

              if (opts.dryRun) {
                if (addedCmds > 0) {
                  const newCmds = mergedCmds.filter((c) => !existingCmds.includes(c));
                  console.log(`[dry-run] Would add ${addedCmds} node commands: ${newCmds.join(", ")}`); // schema-lint: allow-console
                }
                if (addedTools > 0) {
                  const newTools = mergedAllow.filter((t) => !existingAllow.includes(t));
                  console.log(`[dry-run] Would add ${addedTools} agent tools to alsoAllow: ${newTools.join(", ")}`); // schema-lint: allow-console
                }
                if (addedCmds === 0 && addedTools === 0) {
                  console.log("[dry-run] Everything already configured."); // schema-lint: allow-console
                }
                return;
              }

              if (addedCmds === 0 && addedTools === 0) {
                console.log("All BetterClaw commands and tools already configured."); // schema-lint: allow-console
                return;
              }

              configObj.gateway = configObj.gateway ?? {};
              configObj.gateway.nodes = configObj.gateway.nodes ?? {};
              configObj.gateway.nodes.allowCommands = mergedCmds;
              configObj.tools.alsoAllow = mergedAllow;
              await api.runtime.config.writeConfigFile(configObj);

              const parts: string[] = [];
              if (addedCmds > 0) parts.push(`${addedCmds} node commands`);
              if (addedTools > 0) parts.push(`${addedTools} agent tools (${BETTERCLAW_TOOLS.join(", ")})`);
              console.log(`Added ${parts.join(" + ")}. Restart gateway to apply.`); // schema-lint: allow-console
            } catch (err) {
              console.error(`Failed to update config: ${err}`); // schema-lint: allow-console
              process.exit(1);
            }
          });
      },
      { commands: ["betterclaw"] },
    );
  },
};
