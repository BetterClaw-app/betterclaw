import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { ContextManager } from "./context.js";
import type { DeviceContext, Patterns, PluginConfig } from "./types.js";

const ONE_HOUR_MS = 60 * 60 * 1000;

interface TriggerResult {
  id: string;
  message: string;
  priority: "low" | "normal" | "high";
}

type TriggerCheck = (ctx: DeviceContext, patterns: Patterns) => TriggerResult | null;

const TRIGGER_COOLDOWNS: Record<string, number> = {
  "low-battery-away": 4 * 3600,
  "unusual-inactivity": 6 * 3600,
  "sleep-deficit": 24 * 3600,
  "routine-deviation": 4 * 3600,
  "health-weekly-digest": 7 * 86400,
};

const triggers: Array<{ id: string; schedule: "hourly" | "daily" | "weekly"; check: TriggerCheck }> = [
  {
    id: "low-battery-away",
    schedule: "hourly",
    check: (ctx, patterns) => {
      const battery = ctx.device.battery;
      if (!battery || battery.level >= 0.3) return null;
      if (ctx.activity.currentZone === "Home") return null;

      const drain = patterns.batteryPatterns.avgDrainPerHour ?? 0.04;
      const hoursRemaining = drain > 0 ? Math.round(battery.level / drain) : 0;

      return {
        id: "low-battery-away",
        message: `🔋 Battery at ${Math.round(battery.level * 100)}%, draining ~${Math.round(drain * 100)}%/hr. You're away from home — estimated ${hoursRemaining}h remaining. Consider charging.`,
        priority: battery.level < 0.15 ? "high" : "normal",
      };
    },
  },
  {
    id: "unusual-inactivity",
    schedule: "hourly",
    check: (ctx, patterns) => {
      const hour = new Date().getHours();
      if (hour < 12) return null;

      const steps = ctx.device.health?.stepsToday;
      const avg = patterns.healthTrends.stepsAvg7d;
      if (steps == null || avg == null) return null;

      const expectedByNow = avg * (hour / 24);
      if (steps >= expectedByNow * 0.5) return null;

      return {
        id: "unusual-inactivity",
        message: `🚶 It's ${hour}:00 and you've done ${Math.round(steps).toLocaleString()} steps (usually ~${Math.round(expectedByNow).toLocaleString()} by now). Everything okay?`,
        priority: "low",
      };
    },
  },
  {
    id: "sleep-deficit",
    schedule: "daily",
    check: (ctx, patterns) => {
      const hour = new Date().getHours();
      if (hour < 7 || hour > 10) return null;

      const sleep = ctx.device.health?.sleepDurationSeconds;
      const avg = patterns.healthTrends.sleepAvg7d;
      if (sleep == null || avg == null) return null;

      const deficit = avg - sleep;
      if (deficit < 3600) return null;

      const sleepH = Math.floor(sleep / 3600);
      const sleepM = Math.round((sleep % 3600) / 60);
      const avgH = Math.floor(avg / 3600);
      const avgM = Math.round((avg % 3600) / 60);

      return {
        id: "sleep-deficit",
        message: `😴 You slept ${sleepH}h${sleepM}m last night (your average is ${avgH}h${avgM}m). Might want to take it easy today.`,
        priority: "low",
      };
    },
  },
  {
    id: "routine-deviation",
    schedule: "hourly",
    check: (ctx, patterns) => {
      const now = new Date();
      const day = now.getDay();
      const isWeekday = day >= 1 && day <= 5;
      if (!isWeekday) return null;

      const hour = now.getHours() + now.getMinutes() / 60;
      const routines = patterns.locationRoutines.weekday;

      for (const routine of routines) {
        if (!routine.typicalLeave) continue;
        const [h, m] = routine.typicalLeave.split(":").map(Number);
        const typicalLeaveHour = h + m / 60;

        if (
          ctx.activity.currentZone === routine.zone &&
          hour > typicalLeaveHour + 1.5
        ) {
          return {
            id: "routine-deviation",
            message: `📅 It's ${now.getHours()}:${String(now.getMinutes()).padStart(2, "0")} on ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][day]} and you haven't left ${routine.zone} (usually leave at ${routine.typicalLeave}). Just noting in case.`,
            priority: "low",
          };
        }
      }

      return null;
    },
  },
  {
    id: "health-weekly-digest",
    schedule: "weekly",
    check: (ctx, patterns) => {
      if (new Date().getDay() !== 0) return null;
      const hour = new Date().getHours();
      if (hour < 9 || hour > 11) return null;

      const trends = patterns.healthTrends;
      const stats = patterns.eventStats;

      const parts: string[] = [];
      if (trends.stepsAvg7d != null) {
        const trend = trends.stepsTrend ? ` (${trends.stepsTrend})` : "";
        parts.push(`Avg steps: ${Math.round(trends.stepsAvg7d).toLocaleString()}/day${trend}`);
      }
      if (trends.sleepAvg7d != null) {
        const h = Math.floor(trends.sleepAvg7d / 3600);
        const m = Math.round((trends.sleepAvg7d % 3600) / 60);
        parts.push(`Avg sleep: ${h}h${m}m`);
      }
      if (trends.restingHrAvg7d != null) {
        parts.push(`Resting HR: ${Math.round(trends.restingHrAvg7d)}bpm`);
      }
      parts.push(`Events: ${stats.eventsPerDay7d.toFixed(1)}/day, ${Math.round(stats.dropRate7d * 100)}% filtered`);

      return {
        id: "health-weekly-digest",
        message: `📊 Weekly health digest\n\n${parts.join("\n")}`,
        priority: "low",
      };
    },
  },
];

export class ProactiveEngine {
  private context: ContextManager;
  private api: OpenClawPluginApi;
  private config: PluginConfig;
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(context: ContextManager, api: OpenClawPluginApi, config: PluginConfig) {
    this.context = context;
    this.api = api;
    this.config = config;
  }

  startSchedule(): void {
    if (!this.config.proactiveEnabled) return;

    this.interval = setInterval(() => {
      void this.checkAll().catch((err) => {
        this.api.logger.error(`betterclaw: proactive check failed: ${err}`);
      });
    }, ONE_HOUR_MS);
    this.interval.unref?.();

    // Run initial check after 5 minutes (let context populate)
    setTimeout(() => {
      void this.checkAll().catch(() => {});
    }, 5 * 60 * 1000).unref?.();
  }

  stopSchedule(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  async checkAll(): Promise<void> {
    if (!this.context.getRuntimeState().smartMode) {
      return;
    }
    const ctx = this.context.get();
    const patterns = (await this.context.readPatterns()) ?? (await import("./patterns.js")).emptyPatterns();

    for (const trigger of triggers) {
      const lastFired = patterns.triggerCooldowns[trigger.id] ?? 0;
      const cooldown = TRIGGER_COOLDOWNS[trigger.id] ?? 3600;
      if (Date.now() / 1000 - lastFired < cooldown) continue;

      const result = trigger.check(ctx, patterns);
      if (!result) continue;

      this.api.logger.info(`betterclaw: proactive trigger fired: ${trigger.id}`);

      // Write cooldown BEFORE push to prevent runaway retries on failure
      patterns.triggerCooldowns[trigger.id] = Date.now() / 1000;
      await this.context.writePatterns(patterns);

      const message = `[BetterClaw proactive insight — combined signal analysis]\n\n${result.message}`;

      try {
        await this.api.runtime.subagent.run({
          sessionKey: "main",
          message,
          deliver: true,
          idempotencyKey: `trigger-${trigger.id}-${Math.floor(Date.now() / 1000)}`,
        });
      } catch (err) {
        this.api.logger.error(
          `betterclaw: trigger push failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}
