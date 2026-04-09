import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import { makeTmpDir } from "./helpers.js";

// Module-level mocks — must be before imports that use them
vi.mock("../src/pipeline.js", () => ({
  processEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/learner.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/learner.js")>();
  return {
    ...original,
    loadTriageProfile: vi.fn().mockResolvedValue(null),
    runLearner: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../src/reaction-scanner.js", () => ({
  scanPendingReactions: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/jwt.js", () => ({
  storeJwt: vi.fn().mockResolvedValue(null),
}));

vi.mock("../src/diagnostic-logger.js", () => {
  const scopedLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    scoped: vi.fn(() => scopedLogger),
    readLogs: vi.fn().mockResolvedValue({ entries: [], total: 0 }),
    rotate: vi.fn().mockResolvedValue(undefined),
    flush: vi.fn().mockResolvedValue(undefined),
  };
  return {
    initDiagnosticLogger: vi.fn(() => logger),
    dlog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});

import plugin, { resolveConfig } from "../src/index.js";

// ---------------------------------------------------------------------------
// resolveConfig
// ---------------------------------------------------------------------------

describe("resolveConfig", () => {
  it("applies all defaults when config is undefined", () => {
    const cfg = resolveConfig(undefined);
    expect(cfg).toEqual({
      triageModel: "openai/gpt-4o-mini",
      triageApiBase: undefined,
      pushBudgetPerDay: 10,
      patternWindowDays: 14,
      proactiveEnabled: true,
      analysisHour: 5,
      deduplicationCooldowns: {
        "default.battery-low": 3600,
        "default.battery-critical": 1800,
        "default.daily-health": 82800,
        "default.geofence": 300,
      },
      defaultCooldown: 1800,
      calibrationDays: 3,
    });
  });

  it("merges partial config with defaults", () => {
    const cfg = resolveConfig({ pushBudgetPerDay: 20, proactiveEnabled: false });
    expect(cfg.pushBudgetPerDay).toBe(20);
    expect(cfg.proactiveEnabled).toBe(false);
    // defaults preserved
    expect(cfg.triageModel).toBe("openai/gpt-4o-mini");
    expect(cfg.patternWindowDays).toBe(14);
    expect(cfg.analysisHour).toBe(5);
  });

  it("applies defaults for empty object", () => {
    const cfg = resolveConfig({});
    expect(cfg.triageModel).toBe("openai/gpt-4o-mini");
    expect(cfg.pushBudgetPerDay).toBe(10);
    expect(cfg.calibrationDays).toBe(3);
  });

  it("rejects invalid types and falls back to defaults", () => {
    const cfg = resolveConfig({
      pushBudgetPerDay: "not-a-number",
      patternWindowDays: -5,
      proactiveEnabled: "yes",
      analysisHour: 99,
      defaultCooldown: "fast",
      calibrationDays: 0,
    });
    expect(cfg.pushBudgetPerDay).toBe(10); // string -> default
    expect(cfg.patternWindowDays).toBe(14); // negative -> default
    expect(cfg.proactiveEnabled).toBe(true); // string -> default
    expect(cfg.analysisHour).toBe(23); // clamped to max 23
    expect(cfg.defaultCooldown).toBe(1800); // string -> default
    expect(cfg.calibrationDays).toBe(3); // 0 -> default
  });

  it("supports legacy llmModel field", () => {
    const cfg = resolveConfig({ llmModel: "anthropic/claude-3-haiku" });
    expect(cfg.triageModel).toBe("anthropic/claude-3-haiku");
  });

  it("prefers triageModel over llmModel", () => {
    const cfg = resolveConfig({
      triageModel: "openai/gpt-4o",
      llmModel: "anthropic/claude-3-haiku",
    });
    expect(cfg.triageModel).toBe("openai/gpt-4o");
  });

  it("merges custom deduplication cooldowns with defaults", () => {
    const cfg = resolveConfig({
      deduplicationCooldowns: {
        "custom.event": 600,
        "default.battery-low": 7200, // override default
      },
    });
    expect(cfg.deduplicationCooldowns).toEqual({
      "default.battery-low": 7200, // overridden
      "default.battery-critical": 1800, // preserved
      "default.daily-health": 82800, // preserved
      "default.geofence": 300, // preserved
      "custom.event": 600, // added
    });
  });
});

// ---------------------------------------------------------------------------
// Plugin registration
// ---------------------------------------------------------------------------

describe("plugin registration", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir("integration-");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function registerAndInit(apiOverrides?: Record<string, any>): Promise<void> {
    const api = apiOverrides ? { ...mockApi(), ...apiOverrides } : mockApi();
    plugin.register(api as any);
    await vi.waitFor(() => {}, { timeout: 500 });
    await new Promise((r) => setTimeout(r, 20));
  }

  function mockApi() {
    const gatewayMethods = new Map<string, Function>();
    const commands: Array<{ name: string; description: string; handler: Function }> = [];
    const services: Array<{ id: string; start: Function; stop: Function }> = [];
    let toolCount = 0;
    let cliCount = 0;

    return {
      pluginConfig: undefined as Record<string, unknown> | undefined,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      runtime: {
        state: {
          resolveStateDir: () => tmpDir,
        },
        config: {
          loadConfig: vi.fn().mockResolvedValue({}),
          writeConfigFile: vi.fn().mockResolvedValue(undefined),
        },
      },
      subagent: {
        run: vi.fn().mockResolvedValue({ runId: "test" }),
        waitForRun: vi.fn().mockResolvedValue(undefined),
        getSessionMessages: vi.fn().mockResolvedValue({ messages: [] }),
      },
      modelAuth: {
        resolveApiKeyForProvider: vi.fn().mockResolvedValue("test-key"),
      },
      registerGatewayMethod: vi.fn((name: string, handler: Function) => {
        gatewayMethods.set(name, handler);
      }),
      registerCommand: vi.fn((cmd: { name: string; description: string; handler: Function }) => {
        commands.push(cmd);
      }),
      registerService: vi.fn((svc: { id: string; start: Function; stop: Function }) => {
        services.push(svc);
      }),
      registerTool: vi.fn(() => {
        toolCount++;
      }),
      registerCli: vi.fn(() => {
        cliCount++;
      }),
      // Expose captured registrations for assertions
      _gatewayMethods: gatewayMethods,
      _commands: commands,
      _services: services,
      get _toolCount() { return toolCount; },
      get _cliCount() { return cliCount; },
    };
  }

  it("registers all expected gateway methods, tools, commands, services, and CLI", async () => {
    const api = mockApi();
    plugin.register(api as any);

    // Let async init IIFEs settle
    await vi.waitFor(() => {}, { timeout: 500 });
    await new Promise((r) => setTimeout(r, 20));

    // 7 gateway methods
    const expectedMethods = [
      "betterclaw.ping",
      "betterclaw.config",
      "betterclaw.context",
      "betterclaw.learn",
      "betterclaw.snapshot",
      "betterclaw.logs",
      "betterclaw.event",
    ];
    expect(api.registerGatewayMethod).toHaveBeenCalledTimes(7);
    for (const method of expectedMethods) {
      expect(api._gatewayMethods.has(method)).toBe(true);
    }

    // 2 tools (check_tier + get_context)
    expect(api.registerTool).toHaveBeenCalledTimes(2);

    // 1 command (bc)
    expect(api.registerCommand).toHaveBeenCalledTimes(1);
    expect(api._commands[0].name).toBe("bc");
    expect(api._commands[0].description).toBeTruthy();
    expect(typeof api._commands[0].handler).toBe("function");

    // 1 service (betterclaw-engine)
    expect(api.registerService).toHaveBeenCalledTimes(1);
    expect(api._services[0].id).toBe("betterclaw-engine");
    expect(typeof api._services[0].start).toBe("function");
    expect(typeof api._services[0].stop).toBe("function");

    // 1 CLI registration
    expect(api.registerCli).toHaveBeenCalledTimes(1);
  });
});
