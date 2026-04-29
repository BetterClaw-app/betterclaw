import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { readConfigFileSnapshotForWrite, resolveDefaultAgentId } from "openclaw/plugin-sdk/config-runtime";
import type { PluginConfig, DeviceConfig } from "./types.js";
import { errorMessage } from "./types.js";
import { errorFields } from "./errors.js";
import { initDiagnosticLogger } from "./diagnostic-logger.js";
import { handleLogsRpc, resolveAnonymizationKey, type LogsRpcParams } from "./logs-rpc.js";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { ContextManager } from "./context.js";
import { createGetContextTool } from "./tools/get-context.js";
import { EventLog } from "./events.js";
import { RulesEngine } from "./filter.js";
import { PatternEngine } from "./patterns.js";
import { processEvent } from "./pipeline.js";
import type { PipelineDeps } from "./pipeline.js";
import {
  BETTERCLAW_COMMANDS,
  BETTERCLAW_TOOLS,
  mergeAllowCommands,
  mergeAlsoAllow,
  normalizeAgentProfileMode,
  resolveAgentProfileConsent,
} from "./cli.js";
import { storeJwt } from "./jwt.js";
import { runLearner } from "./learner.js";
import { ReactionTracker } from "./reactions.js";
import { createCheckTierTool } from "./tools/check-tier.js";
import { scanPendingReactions } from "./reaction-scanner.js";
import { RoutingConfigStore } from "./routing/config-store.js";
import { AuditLog } from "./routing/audit-log.js";
import { createEditRoutingRulesTool } from "./tools/edit-routing-rules.js";
import { pruneStaleBetterClawIosNodes, resolveActiveBetterClawIosNodeId } from "./node-hygiene.js";
import { AgentProfileManager, type SyncProfileInput } from "./agent-profile.js";
import * as path from "node:path";

export type { PluginConfig } from "./types.js";

const DEFAULT_COOLDOWNS: Record<string, number> = {
  "default.daily-health": 82800,
  "default.geofence": 300,
};

const AGENT_PROFILE_SYNC_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const PLUGIN_VERSION = "3.6.0-dev.0";

const BETTERCLAW_CLI_OPTIONS = {
  commands: ["betterclaw"],
  descriptors: [{ name: "betterclaw", description: "BetterClaw plugin management", hasSubcommands: true }],
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

function cloneConfigForWrite(config: unknown): any {
  return JSON.parse(JSON.stringify(config ?? {}));
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export default {
  id: "betterclaw",
  name: "BetterClaw Context",

  register(api: OpenClawPluginApi) {
    if ((api as { registrationMode?: string }).registrationMode === "cli-metadata") {
      api.registerCli(
        ({ program }) => {
          program.command("betterclaw").description("BetterClaw plugin management");
        },
        BETTERCLAW_CLI_OPTIONS,
      );
      return;
    }

    const config = resolveConfig(api.pluginConfig as Record<string, unknown> | undefined);
    const stateDir = api.runtime.state.resolveStateDir();
    const diagnosticLogger = initDiagnosticLogger(path.join(stateDir, "logs"), api.logger);
    const redactionKey = randomBytes(32);

    diagnosticLogger.info("plugin.service", "loaded", "plugin loaded", { model: config.triageModel, budget: config.pushBudgetPerDay });

    // Context manager (load synchronously — file read deferred to first access)
    const ctxManager = new ContextManager(stateDir, diagnosticLogger.scoped("plugin.context"));
    const agentProfile = new AgentProfileManager(stateDir);

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

    // Track whether async init has completed
    let initialized = false;
    let learnerRunning = false;
    let agentProfileTimer: ReturnType<typeof setInterval> | undefined;
    const resolveCurrentAgentWorkspaceDir = async (): Promise<string> => {
      const runtimeConfig = await api.runtime.config.loadConfig();
      const agentId = resolveDefaultAgentId(runtimeConfig);
      return api.runtime.agent.resolveAgentWorkspaceDir(runtimeConfig, agentId);
    };
    const runLearnerIfIdle = async (): Promise<{ ok: true; durationMs: number } | { ok: false; error: string }> => {
      if (learnerRunning) return { ok: false, error: "already-running" };

      learnerRunning = true;
      const startedAt = Date.now();
      try {
        await runLearner({
          stateDir,
          workspaceDir: await resolveCurrentAgentWorkspaceDir(),
          context: ctxManager,
          events: eventLog,
          reactions: reactionTracker,
          api,
          routing: routingStore,
          audit: auditLog,
        });
        return { ok: true, durationMs: Date.now() - startedAt };
      } catch (err) {
        return { ok: false, error: errorMessage(err) };
      } finally {
        learnerRunning = false;
      }
    };
    const syncAgentProfile = async (
      source: string,
      input: { tier?: "free" | "premium" | null; activeNodeId?: string | null; now?: Date } = {},
    ) => {
      try {
        const runtime = ctxManager.getRuntimeState();
        const syncInput: SyncProfileInput = {
          tier: input.tier ?? runtime.tier,
          now: input.now,
        };
        if (Object.prototype.hasOwnProperty.call(input, "activeNodeId")) {
          syncInput.activeNodeId = input.activeNodeId ?? null;
        }
        const result = await agentProfile.sync(syncInput);
        if (result.changed) {
          diagnosticLogger.info(source, "profile.sync", "agent profile updated", {
            tier: input.tier ?? runtime.tier,
            activeNodeId: input.activeNodeId ?? null,
          });
        }
      } catch (err) {
        diagnosticLogger.warning(source, "profile.sync.failed", "agent profile sync failed", errorFields(err));
      }
    };
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
              .filter((e) => e.decision === "push" || e.decision === "notify")
              .map((e) => ({ subscriptionId: e.event.subscriptionId, at: e.timestamp })),
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

      const connectedNodes = context.nodeRegistry.listConnected();
      const activeNodeId = resolveActiveBetterClawIosNodeId(connectedNodes);
      await syncAgentProfile("plugin.profile", { tier, activeNodeId });

      try {
        const result = await pruneStaleBetterClawIosNodes(stateDir, connectedNodes);
        const pruned = result.prunedNodeIds.length + result.prunedDeviceIds.length;
        if (pruned > 0) {
          diagnosticLogger.info("plugin.rpc", "node.hygiene", "pruned stale BetterClaw iOS nodes", {
            pruned,
            prunedNodePairings: result.prunedNodeIds.length,
            prunedDevicePairings: result.prunedDeviceIds.length,
            kept: result.kept,
          });
        }
      } catch (err) {
        diagnosticLogger.warning("plugin.rpc", "node.hygiene", "node hygiene failed", errorFields(err));
      }

      const meta = ctxManager.get().meta;
      const effectiveBudget = ctxManager.getDeviceConfig().pushBudgetPerDay ?? config.pushBudgetPerDay;
      respond(true, {
        ok: true,
        version: PLUGIN_VERSION,
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

        const result = await runLearnerIfIdle();
        if (result.ok) {
          respond(true, { ok: true, summary: "learner tuned routing rules" });
        } else {
          respond(true, { ok: false, error: result.error });
        }
      } catch (err) {
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
        const loc = state.device.location;
        const health = state.device.health;
        const activity = state.activity;

        const lines: string[] = [];
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

    // Shortcut-result intake RPC — called by the tunnel when a `shortcuts.run`
    // result arrives after its RPC window has closed (user tapped the
    // notification too late, or the tunnel restarted mid-wait). Relays the
    // envelope into the agent session as a persistent turn so the agent still
    // learns the outcome of a shortcut it had given up on.
    api.registerGatewayMethod("betterclaw.shortcutResult", async ({ params, respond }) => {
      try {
        if (!initialized) await initPromise;

        const commandId = typeof params?.commandId === "string" ? params.commandId : "";
        const ok = typeof params?.ok === "boolean" ? params.ok : false;
        const status = typeof params?.status === "string" ? params.status : "";
        const envelopeJSON = typeof params?.envelopeJSON === "string" ? params.envelopeJSON : "";
        const errorText = typeof params?.error === "string" ? params.error : undefined;

        if (!commandId || !status) {
          respond(false, undefined, { code: "INVALID_PARAMS", message: "commandId and status required" });
          return;
        }

        respond(true, { accepted: true });

        let dataSummary = envelopeJSON;
        try {
          const parsed = JSON.parse(envelopeJSON) as Record<string, unknown>;
          if (parsed && typeof parsed === "object" && "data" in parsed) {
            dataSummary = JSON.stringify(parsed.data);
          }
        } catch {
          // Non-JSON envelope — already reported upstream by parser; just forward raw.
        }

        const parts = [
          `Shortcut result (late): commandId=${commandId}`,
          `ok=${ok}`,
          `status=${status}`,
        ];
        if (errorText) {
          parts.push(`error=${errorText}`);
        } else if (ok) {
          parts.push(`data=${dataSummary}`);
        }
        const message = parts.join(" ");

        try {
          await api.runtime.subagent.run({
            sessionKey: "main",
            message,
            deliver: true,
            idempotencyKey: `shortcut-late-${commandId}`,
          });
          diagnosticLogger.info("plugin.rpc", "shortcut.delivered", "late shortcut result delivered to agent",
            { commandId, ok, status });
        } catch (err) {
          diagnosticLogger.error("plugin.rpc", "shortcut.failed", "subagent.run failed for late shortcut result",
            { commandId, ...errorFields(err) });
        }
      } catch (err) {
        diagnosticLogger.error("plugin.rpc", "shortcut.error", "shortcutResult handler error", errorFields(err));
        respond(false, undefined, { code: "INTERNAL_ERROR", message: "shortcutResult processing failed" });
      }
    });

    // Pattern engine
    const patternEngine = new PatternEngine(ctxManager, eventLog, config.patternWindowDays, diagnosticLogger.scoped("plugin.patterns"));

    // Background service
    api.registerService({
      id: "betterclaw-engine",
      start: () => {
        void initPromise.then(() => syncAgentProfile("plugin.profile"));
        patternEngine.startSchedule(config.analysisHour, async () => {
          await diagnosticLogger.rotate();

          if (ctxManager.getRuntimeState().smartMode) {
            try {
              await scanPendingReactions({ reactions: reactionTracker, api });
            } catch (err) {
              diagnosticLogger.error("plugin.reactions", "scan.failed", "reaction scan failed", errorFields(err));
            }

            try {
              const result = await runLearnerIfIdle();
              if (result.ok) {
                diagnosticLogger.info("plugin.learner", "learner.completed", "daily learner completed", { durationMs: result.durationMs });
              } else if (result.error === "already-running") {
                diagnosticLogger.info("plugin.learner", "learner.skipped", "daily learner skipped because another learner is running");
              } else {
                diagnosticLogger.error("plugin.learner", "learner.failed", "daily learner failed", { error: result.error });
              }
            } catch (err) {
              diagnosticLogger.error("plugin.learner", "learner.failed", "daily learner failed", errorFields(err));
            }
          }
        });
        if (!agentProfileTimer) {
          agentProfileTimer = setInterval(() => {
            void syncAgentProfile("plugin.profile");
          }, AGENT_PROFILE_SYNC_INTERVAL_MS);
          agentProfileTimer.unref?.();
        }
        diagnosticLogger.info("plugin.service", "started", "background services started", { analysisHour: config.analysisHour });
      },
      stop: () => {
        patternEngine.stopSchedule();
        if (agentProfileTimer) {
          clearInterval(agentProfileTimer);
          agentProfileTimer = undefined;
        }
        diagnosticLogger.info("plugin.service", "stopped", "background services stopped");
      },
    });

    // CLI setup command
    api.registerCli(
      ({ program }) => {
        const cmd = program.command("betterclaw").description("BetterClaw plugin management");

        cmd
          .command("setup")
          .description("Configure gateway allowedCommands, agent tools, and optional TOOLS.md profile for BetterClaw")
          .option("--dry-run", "Preview changes without writing")
          .option("--yes", "Accept the default prompt answer for generated agent profile setup")
          .option("--agent-profile <mode>", "Maintain a generated TOOLS.md device profile: yes, no, or prompt", "prompt")
          .option("--workspace <path>", "Workspace directory containing the agent TOOLS.md file")
          .action(async (opts: { dryRun?: boolean; yes?: boolean; agentProfile?: string; workspace?: string }) => {
            try {
              const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
              const snapshotObj = snapshot as {
                config?: Record<string, unknown>;
                sourceConfig?: Record<string, unknown>;
                runtimeConfig?: Record<string, unknown>;
              };
              const sourceConfig = snapshotObj.sourceConfig ?? snapshotObj.config ?? {};
              const runtimeConfig = snapshotObj.runtimeConfig ?? snapshotObj.config ?? sourceConfig;
              const configObj = cloneConfigForWrite(sourceConfig);

              // 1. Merge node allowedCommands
              const existingCmds: string[] = Array.isArray(configObj?.gateway?.nodes?.allowCommands)
                ? configObj.gateway.nodes.allowCommands
                : [];
              const mergedCmds = mergeAllowCommands(existingCmds, BETTERCLAW_COMMANDS);
              const missingCmds = BETTERCLAW_COMMANDS.filter((command) => !existingCmds.includes(command));
              const commandsChanged = !arraysEqual(existingCmds, mergedCmds);

              // 2. Merge tools.alsoAllow for plugin tools
              configObj.tools = configObj.tools ?? {};
              const existingAllow: string[] = Array.isArray(configObj.tools.alsoAllow) ? configObj.tools.alsoAllow : [];
              const mergedAllow = mergeAlsoAllow(existingAllow, BETTERCLAW_TOOLS);
              const missingTools = BETTERCLAW_TOOLS.filter((tool) => !existingAllow.includes(tool));
              const toolsChanged = !arraysEqual(existingAllow, mergedAllow);

              const profileMode = normalizeAgentProfileMode(opts.agentProfile ?? "prompt");
              const profileEnabled = await resolveAgentProfileConsent({
                mode: profileMode,
                yes: opts.yes === true,
                isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
                ask: async () => {
                  const rl = createInterface({ input: process.stdin, output: process.stdout });
                  try {
                    const answer = await rl.question("Let BetterClaw maintain a generated TOOLS.md device profile? [Y/n] ");
                    return !answer.trim().toLowerCase().startsWith("n");
                  } finally {
                    rl.close();
                  }
                },
              });
              const agentId = resolveDefaultAgentId(runtimeConfig);
              const workspaceDir = opts.workspace
                ? path.resolve(opts.workspace)
                : api.runtime.agent.resolveAgentWorkspaceDir(runtimeConfig, agentId);
              const toolsFile = path.join(workspaceDir, "TOOLS.md");

              if (opts.dryRun) {
                if (missingCmds.length > 0) {
                  console.log(`[dry-run] Would add ${missingCmds.length} node commands: ${missingCmds.join(", ")}`); // schema-lint: allow-console
                } else if (commandsChanged) {
                  console.log("[dry-run] Would normalize duplicate node command entries."); // schema-lint: allow-console
                }
                if (missingTools.length > 0) {
                  console.log(`[dry-run] Would add ${missingTools.length} agent tools to alsoAllow: ${missingTools.join(", ")}`); // schema-lint: allow-console
                } else if (toolsChanged) {
                  console.log("[dry-run] Would normalize duplicate agent tool allow-list entries."); // schema-lint: allow-console
                }
                if (!commandsChanged && !toolsChanged) {
                  console.log("[dry-run] Everything already configured."); // schema-lint: allow-console
                }
                console.log(`[dry-run] Agent profile maintenance: ${profileEnabled ? `enabled for ${toolsFile}` : "disabled"}.`); // schema-lint: allow-console
                return;
              }

              if (commandsChanged || toolsChanged) {
                configObj.gateway = configObj.gateway ?? {};
                configObj.gateway.nodes = configObj.gateway.nodes ?? {};
                configObj.gateway.nodes.allowCommands = mergedCmds;
                configObj.tools.alsoAllow = mergedAllow;
                await api.runtime.config.writeConfigFile(configObj, writeOptions);

                const parts: string[] = [];
                if (missingCmds.length > 0) parts.push(`${missingCmds.length} node commands`);
                else if (commandsChanged) parts.push("normalized node commands");
                if (missingTools.length > 0) parts.push(`${missingTools.length} agent tools (${BETTERCLAW_TOOLS.join(", ")})`);
                else if (toolsChanged) parts.push("normalized agent tool allow-list");
                console.log(`Added ${parts.join(" + ")}. Restart gateway to apply.`); // schema-lint: allow-console
              } else {
                console.log("All BetterClaw commands and tools already configured."); // schema-lint: allow-console
              }

              await agentProfile.configure({ enabled: profileEnabled, workspaceDir });
              if (profileEnabled) {
                const result = await agentProfile.sync({ tier: ctxManager.getRuntimeState().tier, now: new Date() });
                console.log(`Agent profile maintenance enabled for ${toolsFile}${result.changed ? "." : " (already current)."}`); // schema-lint: allow-console
              } else {
                console.log("Agent profile maintenance disabled."); // schema-lint: allow-console
              }
            } catch (err) {
              console.error(`Failed to update config: ${err}`); // schema-lint: allow-console
              process.exit(1);
            }
          });
      },
      {
        commands: ["betterclaw"],
        descriptors: [{ name: "betterclaw", description: "BetterClaw plugin management", hasSubcommands: true }],
      },
    );
  },
};
