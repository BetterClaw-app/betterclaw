import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginConfig, DeviceConfig } from "./types.js";
import { ContextManager } from "./context.js";
import { createGetContextTool } from "./tools/get-context.js";
import { EventLog } from "./events.js";
import { RulesEngine } from "./filter.js";
import { PatternEngine } from "./patterns.js";
import { ProactiveEngine } from "./triggers.js";
import { processEvent } from "./pipeline.js";
import type { PipelineDeps } from "./pipeline.js";
import { BETTERCLAW_COMMANDS, mergeAllowCommands } from "./cli.js";
import { loadTriageProfile, runLearner } from "./learner.js";
import { ReactionTracker } from "./reactions.js";
import * as os from "node:os";
import * as path from "node:path";

export type { PluginConfig } from "./types.js";

const DEFAULT_CONFIG: PluginConfig = {
  triageModel: "openai/gpt-4o-mini",
  triageApiBase: undefined,
  pushBudgetPerDay: 10,
  patternWindowDays: 14,
  proactiveEnabled: true,
  analysisHour: 5,
};

function resolveConfig(raw: Record<string, unknown> | undefined): PluginConfig {
  const cfg = raw ?? {};
  return {
    triageModel: (cfg.triageModel as string) ?? (cfg.llmModel as string) ?? "openai/gpt-4o-mini",
    triageApiBase: (cfg.triageApiBase as string) ?? undefined,
    pushBudgetPerDay: typeof cfg.pushBudgetPerDay === "number" && cfg.pushBudgetPerDay > 0 ? cfg.pushBudgetPerDay : 10,
    patternWindowDays: typeof cfg.patternWindowDays === "number" && cfg.patternWindowDays > 0 ? cfg.patternWindowDays : 14,
    proactiveEnabled: typeof cfg.proactiveEnabled === "boolean" ? cfg.proactiveEnabled : true,
    analysisHour: typeof cfg.analysisHour === "number" ? Math.max(0, Math.min(23, cfg.analysisHour)) : 5,
  };
}

export default {
  id: "betterclaw",
  name: "BetterClaw Context",

  register(api: OpenClawPluginApi) {
    const config = resolveConfig(api.pluginConfig as Record<string, unknown> | undefined);
    const stateDir = api.runtime.state.resolveStateDir();

    api.logger.info(`betterclaw plugin loaded (model=${config.triageModel}, budget=${config.pushBudgetPerDay})`);

    // Context manager (load synchronously — file read deferred to first access)
    const ctxManager = new ContextManager(stateDir);

    // Event log, rules engine, reaction tracker
    const eventLog = new EventLog(stateDir);
    const rules = new RulesEngine(config.pushBudgetPerDay);
    const reactionTracker = new ReactionTracker(stateDir);

    // Pipeline dependencies
    const pipelineDeps: PipelineDeps = {
      api,
      config,
      context: ctxManager,
      events: eventLog,
      rules,
      reactions: reactionTracker,
      stateDir,
    };

    const pluginVersion = "2.0.0";

    // Track whether async init has completed
    let initialized = false;
    const initPromise = (async () => {
      try {
        await ctxManager.load();
        initialized = true;
      } catch (err) {
        api.logger.error(`betterclaw: context init failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      try {
        await reactionTracker.load();
      } catch (err) {
        api.logger.warn(`betterclaw: reaction tracker load failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      }
      if (initialized) {
        try {
          const recentEvents = await eventLog.readSince(Date.now() / 1000 - 86400);
          rules.restoreCooldowns(
            recentEvents
              .filter((e) => e.decision === "push")
              .map((e) => ({ subscriptionId: e.event.subscriptionId, firedAt: e.event.firedAt })),
          );
          api.logger.info("betterclaw: async init complete");
        } catch (err) {
          api.logger.error(`betterclaw: cooldown restore failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    })();

    // Ping health check
    api.registerGatewayMethod("betterclaw.ping", ({ params, respond }) => {
      const validTiers: Array<"free" | "premium" | "premium+"> = ["free", "premium", "premium+"];
      const rawTier = (params as Record<string, unknown>)?.tier as string;
      const tier = validTiers.includes(rawTier as any) ? (rawTier as "free" | "premium" | "premium+") : "free";
      const smartMode = (params as Record<string, unknown>)?.smartMode === true;

      ctxManager.setRuntimeState({ tier, smartMode });

      const meta = ctxManager.get().meta;
      respond(true, {
        ok: true,
        version: pluginVersion,
        initialized,
        pushesToday: meta.pushesToday,
        budgetRemaining: Math.max(0, config.pushBudgetPerDay - meta.pushesToday),
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
        respond(true, { applied: true });
      } catch (err) {
        api.logger.error(`betterclaw.config error: ${err instanceof Error ? err.message : String(err)}`);
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
        const profile = await loadTriageProfile(stateDir);

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

        respond(true, {
          tier: runtime.tier,
          smartMode: runtime.smartMode,
          activity,
          trends,
          decisions,
          meta,
          routines,
          timestamps,
          triageProfile: profile ? { summary: profile.summary, computedAt: profile.computedAt } : null,
        });
      } catch (err) {
        api.logger.error(`betterclaw.context error: ${err instanceof Error ? err.message : String(err)}`);
        respond(false, undefined, { code: "INTERNAL_ERROR", message: "context fetch failed" });
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
        respond(true, { applied: true });
      } catch (err) {
        api.logger.error(`betterclaw.snapshot error: ${err instanceof Error ? err.message : String(err)}`);
        respond(false, undefined, { code: "INTERNAL_ERROR", message: "snapshot apply failed" });
      }
    });

    // Agent tool
    api.registerTool(createGetContextTool(ctxManager, stateDir), { optional: true });

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
          api.logger.error(`event processing failed: ${err}`);
        });
      } catch (err) {
        api.logger.error(`betterclaw.event handler error: ${err instanceof Error ? err.message : String(err)}`);
        respond(false, undefined, { code: "INTERNAL_ERROR", message: "event processing failed" });
      }
    });

    // Pattern engine + proactive engine
    const patternEngine = new PatternEngine(ctxManager, eventLog, config.patternWindowDays);
    const proactiveEngine = new ProactiveEngine(ctxManager, api, config);

    // Background service
    api.registerService({
      id: "betterclaw-engine",
      start: () => {
        patternEngine.startSchedule(config.analysisHour, async () => {
          // Run learner after patterns (only if smartMode ON)
          if (ctxManager.getRuntimeState().smartMode) {
            try {
              await runLearner({
                stateDir,
                workspaceDir: path.join(os.homedir(), ".openclaw", "workspace"),
                context: ctxManager,
                events: eventLog,
                reactions: reactionTracker,
                api,
              });
              api.logger.info("betterclaw: daily learner completed");
            } catch (err) {
              api.logger.error(`betterclaw: daily learner failed: ${err}`);
            }
          }
        });
        proactiveEngine.startSchedule();
        api.logger.info("betterclaw: background services started");
      },
      stop: () => {
        patternEngine.stopSchedule();
        proactiveEngine.stopSchedule();
        api.logger.info("betterclaw: background services stopped");
      },
    });

    // CLI setup command
    api.registerCli(
      ({ program }) => {
        const cmd = program.command("betterclaw").description("BetterClaw plugin management");

        cmd
          .command("setup")
          .description("Configure gateway allowedCommands for BetterClaw")
          .option("--dry-run", "Preview changes without writing")
          .action(async (opts: { dryRun?: boolean }) => {
            try {
              const currentConfig = await api.runtime.config.loadConfig();
              const existing: string[] =
                (currentConfig as any)?.gateway?.nodes?.allowCommands ?? [];
              const merged = mergeAllowCommands(existing, BETTERCLAW_COMMANDS);
              const added = merged.length - existing.length;

              if (opts.dryRun) {
                console.log(`[dry-run] Would set ${merged.length} allowedCommands (${added} new)`);
                if (added > 0) {
                  const newCmds = merged.filter((c) => !existing.includes(c));
                  console.log(`New commands: ${newCmds.join(", ")}`);
                }
                return;
              }

              if (added === 0) {
                console.log(`All ${BETTERCLAW_COMMANDS.length} BetterClaw commands already configured.`);
                return;
              }

              const configObj = { ...currentConfig } as any;
              configObj.gateway = configObj.gateway ?? {};
              configObj.gateway.nodes = configObj.gateway.nodes ?? {};
              configObj.gateway.nodes.allowCommands = merged;
              await api.runtime.config.writeConfigFile(configObj);

              console.log(`Added ${added} new commands (${merged.length} total). Restart gateway to apply.`);
            } catch (err) {
              console.error(`Failed to update config: ${err}`);
              process.exit(1);
            }
          });
      },
      { commands: ["betterclaw"] },
    );
  },
};
