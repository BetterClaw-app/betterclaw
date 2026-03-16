import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginConfig } from "./types.js";
import { ContextManager } from "./context.js";
import { createGetContextTool } from "./tools/get-context.js";
import { EventLog } from "./events.js";
import { RulesEngine } from "./filter.js";
import { PatternEngine } from "./patterns.js";
import { ProactiveEngine } from "./triggers.js";
import { processEvent } from "./pipeline.js";
import type { PipelineDeps } from "./pipeline.js";

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

    // Event log, rules engine
    const eventLog = new EventLog(stateDir);
    const rules = new RulesEngine(config.pushBudgetPerDay);

    // Pipeline dependencies
    const pipelineDeps: PipelineDeps = {
      api,
      config,
      context: ctxManager,
      events: eventLog,
      rules,
    };

    const pluginVersion = "2.0.0";

    // Track whether async init has completed
    let initialized = false;
    const initPromise = (async () => {
      try {
        await ctxManager.load();
        const recentEvents = await eventLog.readSince(Date.now() / 1000 - 86400);
        rules.restoreCooldowns(
          recentEvents
            .filter((e) => e.decision === "push")
            .map((e) => ({ subscriptionId: e.event.subscriptionId, firedAt: e.event.firedAt })),
        );
        initialized = true;
        api.logger.info("betterclaw: async init complete");
      } catch (err) {
        api.logger.error(`betterclaw: init failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();

    // Ping health check
    api.registerGatewayMethod("betterclaw.ping", ({ params, respond }) => {
      const tier = (params as Record<string, unknown>)?.tier as string ?? "free";
      const smartMode = (params as Record<string, unknown>)?.smartMode === true;

      ctxManager.setRuntimeState({
        tier: tier as "free" | "premium" | "premium+",
        smartMode,
      });

      const meta = ctxManager.get().meta;
      respond(true, {
        ok: true,
        version: pluginVersion,
        initialized,
        pushesToday: meta.pushesToday,
        budgetRemaining: Math.max(0, config.pushBudgetPerDay - meta.pushesToday),
      });
    });

    // Context RPC — returns activity, trends, and recent decisions for iOS Context tab
    api.registerGatewayMethod("betterclaw.context", async ({ respond }) => {
      if (!initialized) await initPromise;

      const state = ctxManager.get();
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
      };

      const routines = patterns
        ? {
            weekday: patterns.locationRoutines.weekday,
            weekend: patterns.locationRoutines.weekend,
          }
        : null;

      respond(true, { activity, trends, decisions, meta, routines });
    });

    // Snapshot RPC — bulk-apply device state for Smart Mode catch-up
    api.registerGatewayMethod("betterclaw.snapshot", async ({ params, respond }) => {
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
    });

    // Agent tool
    api.registerTool(createGetContextTool(ctxManager), { optional: true });

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

        // Persist event BEFORE responding (event safety guarantee)
        await eventLog.append({ event, decision: "received", reason: "queued", timestamp: Date.now() / 1000 });

        respond(true, { accepted: true });

        // Sequential processing — prevents budget races
        eventQueue = eventQueue.then(() => processEvent(pipelineDeps, event)).catch((err) => {
          api.logger.error(`event processing failed: ${err}`);
        });
      } catch (err) {
        api.logger.error(`betterclaw.event handler error: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    // Pattern engine + proactive engine
    const patternEngine = new PatternEngine(ctxManager, eventLog, config.patternWindowDays);
    const proactiveEngine = new ProactiveEngine(ctxManager, api, config);

    // Background service
    api.registerService({
      id: "betterclaw-engine",
      start: () => {
        patternEngine.startSchedule();
        proactiveEngine.startSchedule();
        api.logger.info("betterclaw: background services started");
      },
      stop: () => {
        patternEngine.stopSchedule();
        proactiveEngine.stopSchedule();
        api.logger.info("betterclaw: background services stopped");
      },
    });
  },
};
