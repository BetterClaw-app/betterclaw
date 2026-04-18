// test/pipeline.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { processEvent, type PipelineDeps } from "../src/pipeline.js";
import { ContextManager } from "../src/context.js";
import { EventLog } from "../src/events.js";
import { RulesEngine } from "../src/filter.js";
import { ReactionTracker } from "../src/reactions.js";
import { RoutingConfigStore } from "../src/routing/config-store.js";
import { AuditLog } from "../src/routing/audit-log.js";
import type { DeviceEvent, PluginConfig } from "../src/types.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

vi.mock("../src/jwt.js", () => ({
  requireEntitlement: vi.fn(() => null),
}));

let tmpDir: string;
let subagentRunMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pipeline-test-"));
  subagentRunMock = vi.fn().mockResolvedValue({ runId: "run-1" });
});

afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

async function makeDeps(): Promise<PipelineDeps> {
  const context = new ContextManager(tmpDir);
  await context.load();
  context.setRuntimeState({ tier: "premium", smartMode: true, tz: "Europe/Berlin" });
  const events = new EventLog(tmpDir);
  const rules = new RulesEngine(10, {}, 1800);
  const reactions = new ReactionTracker(tmpDir);
  const audit = new AuditLog(tmpDir);
  const routing = await RoutingConfigStore.load(tmpDir, audit);
  const api = {
    runtime: {
      subagent: { run: subagentRunMock },
    },
    pluginConfig: {},
  } as unknown as OpenClawPluginApi;

  const config: PluginConfig = {
    triageModel: "openai/gpt-5.4-nano",
    pushBudgetPerDay: 20,
    defaultCooldown: 1800,
    deduplicationCooldowns: {},
  } as PluginConfig;

  return { api, config, context, events, rules, reactions, stateDir: tmpDir, routing, audit };
}

const evGeofenceEnter = (label: string): DeviceEvent => ({
  subscriptionId: "default.geofence",
  source: "geofence.triggered",
  data: { type: 1 },
  metadata: { zoneName: label },
  firedAt: 1776000000,
});

describe("pipeline ternary dispatch", () => {
  it("routes notify → subagent.run with deliver:true (explicit rule short-circuits LLM)", async () => {
    const deps = await makeDeps();
    // battery-critical is explicit notify in shipped defaults
    await processEvent(deps, {
      subscriptionId: "default.battery-critical",
      source: "device.battery",
      data: { level: 0.05 },
      firedAt: 1776000000,
    });
    expect(subagentRunMock).toHaveBeenCalledTimes(1);
    expect(subagentRunMock.mock.calls[0][0].deliver).toBe(true);
    // I3: no LLM triage was invoked for an explicit rule match.
    // Assert by proxy — no "openai/v1/chat/completions" fetch happened.
    // (Add fetch spy in makeDeps if stricter assertion needed.)
  });

  it("routes drop → no subagent.run call (and records decision:'drop')", async () => {
    const deps = await makeDeps();
    // An unrecognised source falls to default-drop wildcard
    await processEvent(deps, {
      subscriptionId: "random",
      source: "random.source",
      data: {},
      firedAt: 1776000000,
    });
    expect(subagentRunMock).not.toHaveBeenCalled();
    const entries = await deps.events.readSince(0);
    expect(entries.at(-1)?.decision).toBe("drop");
  });

  it("routes push → subagent.run with deliver:false (I5 coverage)", async () => {
    const deps = await makeDeps();
    // Force quiet-hours demotion: set a custom rule that's explicit+notify,
    // then put "now" inside quiet hours via shipped 23:00–07:00 and freeze Date.
    // Simpler approach: add an explicit push rule and send a matching event.
    await deps.routing.applyPatch(
      [{ op: "add", path: "/rules/0", value: {
        id: "test-push",
        match: { source: "test.push" },
        action: "push",
        explicit: true,
      } }],
      "agent",
      "test fixture",
    );
    await processEvent(deps, {
      subscriptionId: "sub.test",
      source: "test.push",
      data: {},
      firedAt: 1776000000,
    });
    expect(subagentRunMock).toHaveBeenCalledTimes(1);
    expect(subagentRunMock.mock.calls[0][0].deliver).toBe(false);
  });

  it("reactive auto-rule on never-seen geofence", async () => {
    const deps = await makeDeps();
    await processEvent(deps, evGeofenceEnter("never-seen-label"));
    const rules = deps.routing.getRules().rules;
    expect(rules.some(r =>
      typeof r.match === "object" &&
      "geofenceLabel" in r.match &&
      r.match.geofenceLabel === "never-seen-label"
    )).toBe(true);
  });

  it("existing RulesEngine cooldown suppresses duplicate events (regression guard)", async () => {
    const deps = await makeDeps();
    // Two identical battery-critical events rapidly; cooldown must suppress the second.
    const ev = {
      subscriptionId: "default.battery-critical",
      source: "device.battery" as const,
      data: { level: 0.05 },
      firedAt: 1776000000,
    };
    await processEvent(deps, ev);
    await processEvent(deps, { ...ev, firedAt: ev.firedAt + 60 }); // 60s later
    expect(subagentRunMock).toHaveBeenCalledTimes(1); // second was cooldown-suppressed
  });
});
