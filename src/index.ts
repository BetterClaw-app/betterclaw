import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginConfig, DeviceConfig } from "./types.js";
import { ContextManager } from "./context.js";
import { createGetContextTool } from "./tools/get-context.js";
import { EventLog } from "./events.js";
import { RulesEngine } from "./filter.js";
import { PatternEngine } from "./patterns.js";
import { processEvent } from "./pipeline.js";
import type { PipelineDeps } from "./pipeline.js";
import { BETTERCLAW_COMMANDS, BETTERCLAW_TOOLS, mergeAllowCommands, mergeAlsoAllow } from "./cli.js";
import { storeJwt } from "./jwt.js";
import { loadTriageProfile, runLearner } from "./learner.js";
import { ReactionTracker } from "./reactions.js";
import { createCheckTierTool } from "./tools/check-tier.js";
import { scanPendingReactions } from "./reaction-scanner.js";
import * as fs from "node:fs/promises";
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
  calibrationDays: 3,
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
    deduplicationCooldowns: {
      ...DEFAULT_COOLDOWNS,
      ...(typeof cfg.deduplicationCooldowns === "object" && cfg.deduplicationCooldowns !== null
        ? cfg.deduplicationCooldowns as Record<string, number>
        : {}),
    },
    defaultCooldown: typeof cfg.defaultCooldown === "number" && cfg.defaultCooldown > 0 ? cfg.defaultCooldown : 1800,
    calibrationDays: typeof cfg.calibrationDays === "number" && cfg.calibrationDays > 0 ? cfg.calibrationDays : 3,
  };
}

export default {
  id: "betterclaw",
  name: "BetterClaw Context",

  register(api: OpenClawPluginApi) {
    const config = resolveConfig(api.pluginConfig as Record<string, unknown> | undefined);
    const stateDir = api.runtime.state.resolveStateDir();

    api.logger.info(`betterclaw plugin loaded (model=${config.triageModel}, budget=${config.pushBudgetPerDay})`);

    // Calibration state
    let calibrationStartedAt: number | null = null;

    const calibrationFile = path.join(stateDir, "calibration.json");
    (async () => {
      try {
        const raw = await fs.readFile(calibrationFile, "utf8");
        const parsed = JSON.parse(raw);
        calibrationStartedAt = parsed.startedAt ?? null;
      } catch {
        // No calibration file yet — will be created on first premium ping
      }
    })();

    function isCalibrating(): boolean {
      if (!calibrationStartedAt) return true;
      const elapsed = Date.now() / 1000 - calibrationStartedAt;
      return elapsed < config.calibrationDays * 86400;
    }

    // Context manager (load synchronously — file read deferred to first access)
    const ctxManager = new ContextManager(stateDir, api.logger);

    // Event log, rules engine, reaction tracker
    const eventLog = new EventLog(stateDir, api.logger);
    const rules = new RulesEngine(config.pushBudgetPerDay, config.deduplicationCooldowns, config.defaultCooldown);
    const reactionTracker = new ReactionTracker(stateDir, api.logger);

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
    let learnerRunning = false;
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
              .map((e) => ({ subscriptionId: e.event.subscriptionId, firedAt: e.event.firedAt, data: e.event.data })),
          );
          api.logger.info("betterclaw: async init complete");
        } catch (err) {
          api.logger.error(`betterclaw: cooldown restore failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    })();

    // Ping health check
    api.registerGatewayMethod("betterclaw.ping", async ({ params, respond, context }) => {
      const validTiers: Array<"free" | "premium"> = ["free", "premium"];
      const rawTier = (params as Record<string, unknown>)?.tier as string;
      const tier = validTiers.includes(rawTier as any) ? (rawTier as "free" | "premium") : "free";
      const smartMode = (params as Record<string, unknown>)?.smartMode === true;

      const jwt = (params as Record<string, unknown>)?.jwt as string | undefined;
      if (jwt) {
        const payload = await storeJwt(jwt);
        if (payload) {
          api.logger.info(`betterclaw: JWT verified, entitlements=${payload.ent.join(",")}`);
        } else {
          api.logger.warn("betterclaw: JWT verification failed");
        }
      }

      ctxManager.setRuntimeState({ tier, smartMode });

      // Initialize calibration on first premium ping
      if (tier === "premium" && calibrationStartedAt === null) {
        const existingProfile = await loadTriageProfile(stateDir);
        if (existingProfile?.computedAt) {
          calibrationStartedAt = existingProfile.computedAt - config.calibrationDays * 86400;
          api.logger.info("betterclaw: existing triage profile found — skipping calibration");
        } else {
          calibrationStartedAt = Date.now() / 1000;
        }
        fs.writeFile(calibrationFile, JSON.stringify({ startedAt: calibrationStartedAt }), "utf8").catch(() => {});
      }

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
          calibrating: isCalibrating(),
          activity,
          trends,
          decisions,
          meta,
          routines,
          timestamps,
          triageProfile: profile ?? null,
        });
      } catch (err) {
        api.logger.error(`betterclaw.context error: ${err instanceof Error ? err.message : String(err)}`);
        respond(false, undefined, { code: "INTERNAL_ERROR", message: "context fetch failed" });
      }
    });

    // Learn RPC — trigger on-demand triage profile learning
    api.registerGatewayMethod("betterclaw.learn", async ({ respond }) => {
      try {
        if (!initialized) await initPromise;

        if (learnerRunning) {
          respond(true, { ok: false, error: "already-running" });
          return;
        }

        // Soft cooldown: 1 hour since last profile
        const profile = await loadTriageProfile(stateDir);
        if (profile?.computedAt) {
          const elapsed = Date.now() / 1000 - profile.computedAt;
          if (elapsed < 3600) {
            const nextAvailableAt = profile.computedAt + 3600;
            respond(true, { ok: false, error: "cooldown", nextAvailableAt });
            return;
          }
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
          });
          const updatedProfile = await loadTriageProfile(stateDir);
          respond(true, {
            ok: true,
            summary: updatedProfile?.summary ?? null,
            computedAt: updatedProfile?.computedAt ?? null,
          });
        } finally {
          learnerRunning = false;
        }
      } catch (err) {
        learnerRunning = false;
        api.logger.error(`betterclaw.learn error: ${err instanceof Error ? err.message : String(err)}`);
        respond(true, { ok: false, error: err instanceof Error ? err.message : String(err) });
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

    // Agent tools
    api.registerTool(
      createCheckTierTool(ctxManager, () => ({
        calibrating: isCalibrating(),
        calibrationEndsAt: calibrationStartedAt
          ? calibrationStartedAt + config.calibrationDays * 86400
          : undefined,
      })),
    );
    api.registerTool(createGetContextTool(ctxManager, stateDir));

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
          eventLog.append({ event, decision: "error", reason: `processing error: ${err instanceof Error ? err.message : String(err)}`, timestamp: Date.now() / 1000 });
        });
      } catch (err) {
        api.logger.error(`betterclaw.event handler error: ${err instanceof Error ? err.message : String(err)}`);
        respond(false, undefined, { code: "INTERNAL_ERROR", message: "event processing failed" });
      }
    });

    // Pattern engine
    const patternEngine = new PatternEngine(ctxManager, eventLog, config.patternWindowDays, api.logger);

    // Background service
    api.registerService({
      id: "betterclaw-engine",
      start: () => {
        patternEngine.startSchedule(config.analysisHour, async () => {
          if (ctxManager.getRuntimeState().smartMode) {
            // Scan reactions first (feeds into learner)
            try {
              await scanPendingReactions({ reactions: reactionTracker, api });
            } catch (err) {
              api.logger.error(`betterclaw: reaction scan failed: ${err}`);
            }

            // Then run learner
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
        api.logger.info("betterclaw: background services started");
      },
      stop: () => {
        patternEngine.stopSchedule();
        api.logger.info("betterclaw: background services stopped");
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
                  console.log(`[dry-run] Would add ${addedCmds} node commands: ${newCmds.join(", ")}`);
                }
                if (addedTools > 0) {
                  const newTools = mergedAllow.filter((t) => !existingAllow.includes(t));
                  console.log(`[dry-run] Would add ${addedTools} agent tools to alsoAllow: ${newTools.join(", ")}`);
                }
                if (addedCmds === 0 && addedTools === 0) {
                  console.log("[dry-run] Everything already configured.");
                }
                return;
              }

              if (addedCmds === 0 && addedTools === 0) {
                console.log("All BetterClaw commands and tools already configured.");
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
              console.log(`Added ${parts.join(" + ")}. Restart gateway to apply.`);
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
