import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import zlib from "node:zlib";
import { makeTmpDir } from "./helpers.js";
import { readConfigFileSnapshotForWrite } from "openclaw/plugin-sdk/config-runtime";
import { BETTERCLAW_COMMANDS } from "../src/cli.js";

// Module-level mocks — must be before imports that use them
vi.mock("../src/pipeline.js", () => ({
  processEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/learner.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/learner.js")>();
  return {
    ...original,
    runLearner: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../src/reaction-scanner.js", () => ({
  scanPendingReactions: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/jwt.js", () => ({
  storeJwt: vi.fn().mockResolvedValue(null),
}));

vi.mock("openclaw/plugin-sdk/config-runtime", async (importOriginal) => {
  const original = await importOriginal<typeof import("openclaw/plugin-sdk/config-runtime")>();
  return {
    ...original,
    readConfigFileSnapshotForWrite: vi.fn(),
  };
});

vi.mock("../src/diagnostic-logger.js", () => {
  const scopedLogger = { info: vi.fn(), warn: vi.fn(), warning: vi.fn(), error: vi.fn() };
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    scoped: vi.fn(() => scopedLogger),
    readLogs: vi.fn().mockResolvedValue({ entries: [], total: 0 }),
    rotate: vi.fn().mockResolvedValue(undefined),
    flush: vi.fn().mockResolvedValue(undefined),
  };
  return {
    initDiagnosticLogger: vi.fn(() => logger),
    dlog: { info: vi.fn(), warn: vi.fn(), warning: vi.fn(), error: vi.fn(), debug: vi.fn() },
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
        "default.daily-health": 82800,
        "default.geofence": 300,
      },
      defaultCooldown: 1800,
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
  });

  it("rejects invalid types and falls back to defaults", () => {
    const cfg = resolveConfig({
      pushBudgetPerDay: "not-a-number",
      patternWindowDays: -5,
      proactiveEnabled: "yes",
      analysisHour: 99,
      defaultCooldown: "fast",
    });
    expect(cfg.pushBudgetPerDay).toBe(10); // string -> default
    expect(cfg.patternWindowDays).toBe(14); // negative -> default
    expect(cfg.proactiveEnabled).toBe(true); // string -> default
    expect(cfg.analysisHour).toBe(23); // clamped to max 23
    expect(cfg.defaultCooldown).toBe(1800); // string -> default
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
        "default.daily-health": 43200, // override default
      },
    });
    expect(cfg.deduplicationCooldowns).toEqual({
      "default.daily-health": 43200, // overridden
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
    vi.mocked(readConfigFileSnapshotForWrite).mockResolvedValue({
      snapshot: { config: {} } as any,
      writeOptions: {},
    });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function registerAndInit(apiOverrides?: Record<string, any>): Promise<void> {
    const api = apiOverrides ? { ...mockApi(), ...apiOverrides } : mockApi();
    plugin.register(api as any);
    await vi.waitFor(() => { expect(api.registerGatewayMethod).toHaveBeenCalled(); }, { timeout: 500 });
    // Let fire-and-forget async init (context load, calibration) settle
    await new Promise((r) => setTimeout(r, 50));
  }

  function mockApi() {
    const gatewayMethods = new Map<string, Function>();
    const commands: Array<{ name: string; description: string; handler: Function }> = [];
    const services: Array<{ id: string; start: Function; stop: Function }> = [];
    let toolCount = 0;
    let cliCount = 0;
    let cliRegistrar: Function | undefined;
    let cliOptions: any;

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
        agent: {
          resolveAgentWorkspaceDir: vi.fn((_cfg: any, _agentId: string) => path.join(tmpDir, "workspace")),
        },
        subagent: {
          run: vi.fn().mockResolvedValue({ runId: "test" }),
          waitForRun: vi.fn().mockResolvedValue({ status: "completed" }),
          getSessionMessages: vi.fn().mockResolvedValue({ messages: [] }),
          deleteSession: vi.fn().mockResolvedValue(undefined),
        },
        modelAuth: {
          resolveApiKeyForProvider: vi.fn().mockResolvedValue({ apiKey: "test-key" }),
        },
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
      registerCli: vi.fn((registrar: Function, opts?: any) => {
        cliCount++;
        cliRegistrar = registrar;
        cliOptions = opts;
      }),
      // Expose captured registrations for assertions
      _gatewayMethods: gatewayMethods,
      _commands: commands,
      _services: services,
      get _toolCount() { return toolCount; },
      get _cliCount() { return cliCount; },
      get _cliRegistrar() { return cliRegistrar; },
      get _cliOptions() { return cliOptions; },
    };
  }

  it("registers all expected gateway methods, tools, commands, services, and CLI", async () => {
    const api = mockApi();
    plugin.register(api as any);

    // Let async init IIFEs settle
    await vi.waitFor(() => { expect(api.registerGatewayMethod).toHaveBeenCalled(); }, { timeout: 500 });
    await new Promise((r) => setTimeout(r, 50));

    // 8 gateway methods
    const expectedMethods = [
      "betterclaw.ping",
      "betterclaw.config",
      "betterclaw.context",
      "betterclaw.learn",
      "betterclaw.snapshot",
      "betterclaw.logs",
      "betterclaw.event",
      "betterclaw.shortcutResult",
    ];
    expect(api.registerGatewayMethod).toHaveBeenCalledTimes(8);
    for (const method of expectedMethods) {
      expect(api._gatewayMethods.has(method)).toBe(true);
    }

    // 3 tools (check_tier + get_context + edit_routing_rules)
    expect(api.registerTool).toHaveBeenCalledTimes(3);

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
    expect(api._cliOptions).toEqual({
      commands: ["betterclaw"],
      descriptors: [{ name: "betterclaw", description: "BetterClaw plugin management", hasSubcommands: true }],
    });
  });

  it("registers CLI metadata without full runtime helpers", () => {
    const api = {
      registrationMode: "cli-metadata",
      registerCli: vi.fn(),
    };

    expect(() => plugin.register(api as any)).not.toThrow();
    expect(api.registerCli).toHaveBeenCalledTimes(1);
    expect(api.registerCli.mock.calls[0][1]).toEqual({
      commands: ["betterclaw"],
      descriptors: [{ name: "betterclaw", description: "BetterClaw plugin management", hasSubcommands: true }],
    });
  });

  // Helper: register plugin and return the API with settled async init
  async function registerPlugin(apiOverrides?: Record<string, any>) {
    const api = apiOverrides ? { ...mockApi(), ...apiOverrides } : mockApi();
    plugin.register(api as any);
    await vi.waitFor(() => { expect(api.registerGatewayMethod).toHaveBeenCalled(); }, { timeout: 500 });
    // Let fire-and-forget async init (context load, calibration) settle
    await new Promise((r) => setTimeout(r, 50));
    return api;
  }

  // Helper: create a mock context object for RPC handlers
  function mockContext() {
    return {
      hasConnectedMobileNode: () => false,
      nodeRegistry: {
        listConnected: () => [],
      },
    };
  }

  // Helper: invoke a gateway method by name
  async function invokeMethod(
    api: ReturnType<typeof mockApi>,
    method: string,
    params: Record<string, unknown> = {},
    context = mockContext(),
  ): Promise<{ ok: boolean; result?: any; error?: any }> {
    const handler = api._gatewayMethods.get(method);
    if (!handler) throw new Error(`No handler for ${method}`);
    let response: { ok: boolean; result?: any; error?: any } | undefined;
    const respond = (ok: boolean, result?: any, error?: any) => {
      response = { ok, result, error };
    };
    await handler({ params, respond, context });
    return response!;
  }

  function captureSetupAction(api: ReturnType<typeof mockApi>) {
    let action: Function | undefined;
    const setupCommand = {
      description: vi.fn(() => setupCommand),
      option: vi.fn(() => setupCommand),
      action: vi.fn((handler: Function) => {
        action = handler;
        return setupCommand;
      }),
    };
    const rootCommand = {
      description: vi.fn(() => rootCommand),
      command: vi.fn(() => setupCommand),
    };
    const program = {
      command: vi.fn(() => rootCommand),
    };

    api._cliRegistrar?.({ program });
    if (!action) throw new Error("betterclaw setup action was not registered");
    return { action, setupCommand, rootCommand, program };
  }

  describe("betterclaw setup CLI", () => {
    it("registers setup options for profile maintenance", async () => {
      const api = await registerPlugin();
      const { setupCommand, program, rootCommand } = captureSetupAction(api);

      expect(program.command).toHaveBeenCalledWith("betterclaw");
      expect(rootCommand.command).toHaveBeenCalledWith("setup");
      expect(setupCommand.option.mock.calls.map((call) => call[0])).toEqual(expect.arrayContaining([
        "--dry-run",
        "--yes",
        "--agent-profile <mode>",
        "--workspace <path>",
      ]));
    });

    it("does not write config or TOOLS.md in dry-run mode", async () => {
      const api = await registerPlugin();
      const { action } = captureSetupAction(api);
      const workspace = path.join(tmpDir, "workspace");
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        await action({ dryRun: true, agentProfile: "yes", workspace });
      } finally {
        logSpy.mockRestore();
      }

      expect(api.runtime.config.writeConfigFile).not.toHaveBeenCalled();
      await expect(fs.readFile(path.join(workspace, "TOOLS.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("does not sync an existing enabled profile during dry-run setup", async () => {
      const workspace = path.join(tmpDir, "workspace");
      await fs.mkdir(tmpDir, { recursive: true });
      await fs.writeFile(path.join(tmpDir, "agent-profile.json"), `${JSON.stringify({
        enabled: true,
        workspaceDir: workspace,
        toolsFile: path.join(workspace, "TOOLS.md"),
        lastActiveNodeId: null,
        lastTier: null,
        lastFactsKey: null,
        lastSyncAt: null,
      }, null, 2)}\n`);

      const api = await registerPlugin();
      const { action } = captureSetupAction(api);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        await action({ dryRun: true, agentProfile: "yes", workspace });
      } finally {
        logSpy.mockRestore();
      }

      expect(api.runtime.config.writeConfigFile).not.toHaveBeenCalled();
      await expect(fs.readFile(path.join(workspace, "TOOLS.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("writes config when duplicate existing entries hide missing commands by length", async () => {
      const existingCommands = [
        ...BETTERCLAW_COMMANDS.filter((command) => command !== "system.notify"),
        "location.get",
      ];
      vi.mocked(readConfigFileSnapshotForWrite).mockResolvedValue({
        snapshot: {
          sourceConfig: {
            gateway: { nodes: { allowCommands: existingCommands } },
            tools: { alsoAllow: ["check_tier", "check_tier", "get_context"] },
          },
          runtimeConfig: {
            gateway: { nodes: { allowCommands: existingCommands } },
            tools: { alsoAllow: ["check_tier", "check_tier", "get_context"] },
          },
          config: {
            gateway: { nodes: { allowCommands: existingCommands } },
            tools: { alsoAllow: ["check_tier", "check_tier", "get_context"] },
          },
        } as any,
        writeOptions: {},
      });
      const api = await registerPlugin();
      const { action } = captureSetupAction(api);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        await action({ agentProfile: "no", workspace: path.join(tmpDir, "workspace") });
      } finally {
        logSpy.mockRestore();
      }

      expect(api.runtime.config.writeConfigFile).toHaveBeenCalledTimes(1);
      const written = api.runtime.config.writeConfigFile.mock.calls[0][0];
      expect(written.gateway.nodes.allowCommands).toContain("system.notify");
      expect(written.gateway.nodes.allowCommands.filter((command: string) => command === "location.get")).toHaveLength(1);
      expect(written.tools.alsoAllow).toContain("edit_routing_rules");
      expect(written.tools.alsoAllow.filter((tool: string) => tool === "check_tier")).toHaveLength(1);
    });

    it("can disable generated agent profile maintenance", async () => {
      const api = await registerPlugin();
      const { action } = captureSetupAction(api);
      const workspace = path.join(tmpDir, "workspace");
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        await action({ agentProfile: "no", workspace });
      } finally {
        logSpy.mockRestore();
      }

      await invokeMethod(api, "betterclaw.ping", { tier: "premium", smartMode: true }, {
        hasConnectedMobileNode: () => true,
        nodeRegistry: {
          listConnected: () => [{
            nodeId: "currentIos",
            clientId: "openclaw-ios",
            platform: "iOS",
            deviceFamily: "iPhone",
            commands: ["location.get"],
            connectedAtMs: Date.now(),
          }],
        },
      });

      const state = JSON.parse(await fs.readFile(path.join(tmpDir, "agent-profile.json"), "utf8"));
      expect(state.enabled).toBe(false);
      await expect(fs.readFile(path.join(workspace, "TOOLS.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("updates TOOLS.md with tier and active node id on ping", async () => {
      const api = await registerPlugin();
      const { action } = captureSetupAction(api);
      const workspace = path.join(tmpDir, "workspace");
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        await action({ agentProfile: "yes", workspace });
      } finally {
        logSpy.mockRestore();
      }

      await invokeMethod(api, "betterclaw.ping", { tier: "premium", smartMode: true }, {
        hasConnectedMobileNode: () => true,
        nodeRegistry: {
          listConnected: () => [{
            nodeId: "currentIos",
            clientId: "openclaw-ios",
            platform: "iOS",
            deviceFamily: "iPhone",
            commands: ["location.get"],
            connectedAtMs: 10,
          }],
        },
      });

      const tools = await fs.readFile(path.join(workspace, "TOOLS.md"), "utf8");
      expect(tools).toContain("Tier: premium");
      expect(tools).toContain("Active node: currentIos");
      expect(tools).toContain("call `location.get` on the active BetterClaw node");
    });
  });

  // -------------------------------------------------------------------------
  // betterclaw.ping
  // -------------------------------------------------------------------------
  describe("betterclaw.ping", () => {
    it("updates tier and returns status", async () => {
      const api = await registerPlugin();
      const res = await invokeMethod(api, "betterclaw.ping", { tier: "free", smartMode: false });
      expect(res.ok).toBe(true);
      expect(res.result.ok).toBe(true);
      expect(res.result.initialized).toBe(true);
      expect(res.result.nodeConnected).toBe(false);
      expect(res.result.version).toMatch(/^\d+\.\d+\.\d+/);
    });

    it("persists tier — verifiable via betterclaw.context", async () => {
      const api = await registerPlugin();
      await invokeMethod(api, "betterclaw.ping", { tier: "premium", smartMode: true });
      const ctx = await invokeMethod(api, "betterclaw.context");
      expect(ctx.result.tier).toBe("premium");
      expect(ctx.result.smartMode).toBe(true);
    });

    it("defaults invalid tier to free", async () => {
      const api = await registerPlugin();
      await invokeMethod(api, "betterclaw.ping", { tier: "bogus", smartMode: false });
      const ctx = await invokeMethod(api, "betterclaw.context");
      expect(ctx.result.tier).toBe("free");
    });

    it("prunes stale disconnected BetterClaw iOS node pairings when a current iOS node is connected", async () => {
      const api = await registerPlugin();
      const nodesDir = path.join(tmpDir, "nodes");
      const devicesDir = path.join(tmpDir, "devices");
      const pairedPath = path.join(nodesDir, "paired.json");
      const devicesPath = path.join(devicesDir, "paired.json");
      await fs.mkdir(nodesDir, { recursive: true });
      await fs.mkdir(devicesDir, { recursive: true });
      const now = Date.now();
      await fs.writeFile(pairedPath, JSON.stringify({
        staleIos: {
          nodeId: "staleIos",
          displayName: "iPhone",
          platform: "iOS",
          deviceFamily: "iPhone",
          modelIdentifier: "iPhone16,2",
          commands: ["location.get", "health.steps"],
          approvedAtMs: 1,
          lastConnectedAtMs: 1,
        },
        currentIos: {
          nodeId: "currentIos",
          displayName: "iPhone",
          platform: "iOS",
          deviceFamily: "iPhone",
          modelIdentifier: "iPhone16,2",
          commands: ["location.get", "health.steps"],
          approvedAtMs: now,
          lastConnectedAtMs: now,
        },
        macNode: {
          nodeId: "macNode",
          displayName: "Mac",
          platform: "macOS",
          deviceFamily: "Mac",
          commands: ["system.run"],
          approvedAtMs: 1,
        },
      }, null, 2));
      await fs.writeFile(devicesPath, JSON.stringify({
        oldIosDevice: {
          deviceId: "oldIosDevice",
          displayName: "iPhone",
          platform: "iOS 26.4.0",
          clientId: "openclaw-ios",
          clientMode: "node",
          roles: ["operator", "node"],
          approvedAtMs: 1,
        },
        foregroundOnlyDevice: {
          deviceId: "foregroundOnlyDevice",
          displayName: "iPhone (foreground)",
          platform: "iOS 26.4.0",
          clientId: "openclaw-ios",
          clientMode: "node",
          roles: ["operator"],
          approvedAtMs: 1,
        },
        currentIos: {
          deviceId: "currentIos",
          displayName: "iPhone",
          platform: "iOS 26.4.1",
          clientId: "openclaw-ios",
          clientMode: "node",
          roles: ["operator", "node"],
          approvedAtMs: now,
        },
      }, null, 2));

      await invokeMethod(api, "betterclaw.ping", { tier: "premium", smartMode: true }, {
        hasConnectedMobileNode: () => true,
        nodeRegistry: {
          listConnected: () => [{
            nodeId: "currentIos",
            clientId: "openclaw-ios",
            platform: "iOS",
            deviceFamily: "iPhone",
            modelIdentifier: "iPhone16,2",
            commands: ["location.get", "health.steps"],
            connectedAtMs: now,
          }],
        },
      });

      const paired = JSON.parse(await fs.readFile(pairedPath, "utf8"));
      const devices = JSON.parse(await fs.readFile(devicesPath, "utf8"));
      expect(paired.staleIos).toBeUndefined();
      expect(paired.currentIos).toBeTruthy();
      expect(paired.macNode).toBeTruthy();
      expect(devices.oldIosDevice).toBeUndefined();
      expect(devices.foregroundOnlyDevice).toBeTruthy();
      expect(devices.currentIos).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------
  // betterclaw.event
  // -------------------------------------------------------------------------
  describe("betterclaw.event", () => {
    it("returns INVALID_PARAMS when subscriptionId missing", async () => {
      const api = await registerPlugin();
      const res = await invokeMethod(api, "betterclaw.event", { source: "device.battery", data: {} });
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("INVALID_PARAMS");
    });

    it("returns INVALID_PARAMS when source missing", async () => {
      const api = await registerPlugin();
      const res = await invokeMethod(api, "betterclaw.event", { subscriptionId: "test", data: {} });
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("INVALID_PARAMS");
    });

    it("coerces data to {} when non-object", async () => {
      const { processEvent } = await import("../src/pipeline.js");
      const mockProcessEvent = processEvent as ReturnType<typeof vi.fn>;
      mockProcessEvent.mockClear();

      const api = await registerPlugin();
      await invokeMethod(api, "betterclaw.event", {
        subscriptionId: "test.event",
        source: "device.battery",
        data: "not-an-object",
      });
      // Let queue drain
      await new Promise((r) => setTimeout(r, 100));
      expect(mockProcessEvent).toHaveBeenCalledTimes(1);
      const eventArg = mockProcessEvent.mock.calls[0][1];
      expect(eventArg.data).toEqual({});
    });

    it("defaults firedAt to current time", async () => {
      const { processEvent } = await import("../src/pipeline.js");
      const mockProcessEvent = processEvent as ReturnType<typeof vi.fn>;
      mockProcessEvent.mockClear();

      const now = 1700000000000;
      vi.spyOn(Date, "now").mockReturnValue(now);

      const api = await registerPlugin();
      await invokeMethod(api, "betterclaw.event", {
        subscriptionId: "test.event",
        source: "device.battery",
      });
      await new Promise((r) => setTimeout(r, 100));

      expect(mockProcessEvent).toHaveBeenCalledTimes(1);
      const eventArg = mockProcessEvent.mock.calls[0][1];
      expect(eventArg.firedAt).toBe(now / 1000);
    });

    it("accepts valid event and responds immediately", async () => {
      const api = await registerPlugin();
      const res = await invokeMethod(api, "betterclaw.event", {
        subscriptionId: "test.event",
        source: "device.battery",
        data: { level: 0.5 },
        firedAt: 1700000000,
      });
      expect(res.ok).toBe(true);
      expect(res.result.accepted).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // betterclaw.shortcutResult
  // -------------------------------------------------------------------------
  describe("betterclaw.shortcutResult", () => {
    it("returns INVALID_PARAMS when commandId missing", async () => {
      const api = await registerPlugin();
      const res = await invokeMethod(api, "betterclaw.shortcutResult", {
        status: "success",
        ok: true,
        envelopeJSON: "{}",
      });
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("INVALID_PARAMS");
    });

    it("returns INVALID_PARAMS when status missing", async () => {
      const api = await registerPlugin();
      const res = await invokeMethod(api, "betterclaw.shortcutResult", {
        commandId: "cmd-x",
        ok: true,
        envelopeJSON: "{}",
      });
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("INVALID_PARAMS");
    });

    it("accepts valid result and responds immediately", async () => {
      const api = await registerPlugin();
      const res = await invokeMethod(api, "betterclaw.shortcutResult", {
        commandId: "cmd-1",
        ok: true,
        status: "success",
        envelopeJSON: `{"v":1,"ok":true,"cmd":"cmd-1","status":"success","data":{"toggled":2},"chk":"END"}`,
        receivedAt: 1700000000,
      });
      expect(res.ok).toBe(true);
      expect(res.result.accepted).toBe(true);
    });

    it("relays the envelope to the agent session via subagent.run", async () => {
      const api = await registerPlugin();
      await invokeMethod(api, "betterclaw.shortcutResult", {
        commandId: "cmd-relay",
        ok: true,
        status: "success",
        envelopeJSON: `{"v":1,"ok":true,"cmd":"cmd-relay","status":"success","data":{"toggled":2},"chk":"END"}`,
        receivedAt: 1700000000,
      });
      // Allow the fire-and-forget relay to complete
      await new Promise((r) => setTimeout(r, 50));
      expect(api.runtime.subagent.run).toHaveBeenCalledTimes(1);
      const args = (api.runtime.subagent.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(args.sessionKey).toBe("main");
      expect(args.deliver).toBe(true);
      expect(args.idempotencyKey).toBe("shortcut-late-cmd-relay");
      expect(args.message).toContain("cmd-relay");
      expect(args.message).toContain("status=success");
      expect(args.message).toContain(`"toggled":2`);
    });

    it("includes error message when envelope signals failure", async () => {
      const api = await registerPlugin();
      await invokeMethod(api, "betterclaw.shortcutResult", {
        commandId: "cmd-err",
        ok: false,
        status: "error",
        envelopeJSON: `{"v":1,"ok":false,"cmd":"cmd-err","status":"error","error":"boom","chk":"END"}`,
        error: "boom",
        receivedAt: 1700000000,
      });
      await new Promise((r) => setTimeout(r, 50));
      expect(api.runtime.subagent.run).toHaveBeenCalledTimes(1);
      const args = (api.runtime.subagent.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(args.message).toContain("ok=false");
      expect(args.message).toContain("status=error");
      expect(args.message).toContain("error=boom");
    });

    it("tolerates non-JSON envelope by forwarding it as the data summary", async () => {
      const api = await registerPlugin();
      await invokeMethod(api, "betterclaw.shortcutResult", {
        commandId: "cmd-bad",
        ok: true,
        status: "success",
        envelopeJSON: "not-json",
        receivedAt: 1700000000,
      });
      await new Promise((r) => setTimeout(r, 50));
      expect(api.runtime.subagent.run).toHaveBeenCalledTimes(1);
      const args = (api.runtime.subagent.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(args.message).toContain("data=not-json");
    });
  });

  // -------------------------------------------------------------------------
  // Event queue
  // -------------------------------------------------------------------------
  describe("event queue", () => {
    it("processes events sequentially", async () => {
      const { processEvent } = await import("../src/pipeline.js");
      const mockProcessEvent = processEvent as ReturnType<typeof vi.fn>;
      mockProcessEvent.mockClear();

      const order: number[] = [];
      mockProcessEvent.mockImplementation(async (_deps: any, event: any) => {
        const idx = parseInt(event.subscriptionId.split("-")[1]);
        order.push(idx);
        await new Promise((r) => setTimeout(r, 20));
      });

      const api = await registerPlugin();
      // Fire 3 events rapidly
      await invokeMethod(api, "betterclaw.event", { subscriptionId: "evt-1", source: "device.battery", data: {} });
      await invokeMethod(api, "betterclaw.event", { subscriptionId: "evt-2", source: "device.battery", data: {} });
      await invokeMethod(api, "betterclaw.event", { subscriptionId: "evt-3", source: "device.battery", data: {} });

      // Wait for all to complete
      await new Promise((r) => setTimeout(r, 200));
      expect(order).toEqual([1, 2, 3]);
      mockProcessEvent.mockResolvedValue(undefined);
    });

    it("catches processEvent errors and continues queue", async () => {
      const { processEvent } = await import("../src/pipeline.js");
      const mockProcessEvent = processEvent as ReturnType<typeof vi.fn>;
      mockProcessEvent.mockClear();

      let callCount = 0;
      mockProcessEvent.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) throw new Error("simulated failure");
      });

      const api = await registerPlugin();
      await invokeMethod(api, "betterclaw.event", { subscriptionId: "fail-evt", source: "device.battery", data: {} });
      await invokeMethod(api, "betterclaw.event", { subscriptionId: "ok-evt", source: "device.battery", data: {} });

      await new Promise((r) => setTimeout(r, 200));
      // Both should have been called — queue continues after error
      expect(callCount).toBe(2);
      mockProcessEvent.mockResolvedValue(undefined);
    });
  });

  // -------------------------------------------------------------------------
  // betterclaw.snapshot
  // -------------------------------------------------------------------------
  describe("betterclaw.snapshot", () => {
    it("applies location snapshot", async () => {
      const api = await registerPlugin();
      await invokeMethod(api, "betterclaw.snapshot", {
        location: { latitude: 48.1351, longitude: 11.5820 },
      });
      const bcCmd = api._commands.find((c) => c.name === "bc");
      const result = bcCmd!.handler() as { text: string };
      expect(result.text).toContain("48.1351");
      expect(result.text).toContain("11.5820");
    });

    it("applies health snapshot", async () => {
      const api = await registerPlugin();
      await invokeMethod(api, "betterclaw.snapshot", {
        health: { stepsToday: 8500 },
      });
      const bcCmd = api._commands.find((c) => c.name === "bc");
      const result = bcCmd!.handler() as { text: string };
      expect(result.text).toContain("8,500");
    });

    it("applies geofence snapshot", async () => {
      const api = await registerPlugin();
      await invokeMethod(api, "betterclaw.snapshot", {
        geofence: { type: "enter", zoneName: "Home", latitude: 48.1, longitude: 11.5 },
      });
      const bcCmd = api._commands.find((c) => c.name === "bc");
      const result = bcCmd!.handler() as { text: string };
      expect(result.text).toContain("Zone: Home");
    });

    it("applies partial multi-field snapshot", async () => {
      const api = await registerPlugin();
      await invokeMethod(api, "betterclaw.snapshot", {
        battery: { level: 0.5, state: "unplugged", isLowPowerMode: true },
        health: { stepsToday: 3000 },
      });
      const bcCmd = api._commands.find((c) => c.name === "bc");
      const result = bcCmd!.handler() as { text: string };
      // Battery is no longer rendered by /bc output, but health still is
      expect(result.text).not.toContain("Battery");
      expect(result.text).toContain("3,000");
    });

    it("handles empty snapshot", async () => {
      const api = await registerPlugin();
      const res = await invokeMethod(api, "betterclaw.snapshot", {});
      expect(res.ok).toBe(true);
      expect(res.result.applied).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // betterclaw.logs
  // -------------------------------------------------------------------------
  describe("betterclaw.logs", () => {
    it("requires settings and returns redacted envelope", async () => {
      const { initDiagnosticLogger } = await import("../src/diagnostic-logger.js");
      const mockInit = initDiagnosticLogger as ReturnType<typeof vi.fn>;

      const loggerInstance = mockInit.mock.results[0]?.value ?? mockInit();
      loggerInstance.readLogs.mockResolvedValue({ entries: [], total: 0 });

      const api = await registerPlugin();

      const lastLogger = mockInit.mock.results[mockInit.mock.results.length - 1].value;
      lastLogger.readLogs.mockResolvedValue({
        entries: [
          { timestamp: Date.now() / 1000, level: "info", source: "plugin.service", event: "loaded", message: "m" },
        ],
        total: 1,
      });

      // Missing settings → structured error
      const bad = await invokeMethod(api, "betterclaw.logs", { limit: 10 });
      expect(bad.ok).toBe(false);
      expect(bad.error?.code).toBe("MISSING_SETTINGS");

      // Valid settings → envelope
      const allOn = {
        connection: true, heartbeat: true, commands: true, dns: true,
        lifecycle: true,
        subscriptions: true, health: true, location: true, geofence: true,
      };
      const res = await invokeMethod(api, "betterclaw.logs", { settings: allOn, limit: 10 });
      expect(res.ok).toBe(true);
      expect(res.result.schemaVersion).toBe(1);
      expect(res.result.manifestVersion).toBeGreaterThan(0);
      // Task 5: entries is base64-encoded gzipped JSON.
      expect(typeof res.result.entries).toBe("string");
      const decompressed = zlib
        .gunzipSync(Buffer.from(res.result.entries, "base64"))
        .toString("utf8");
      expect(Array.isArray(JSON.parse(decompressed))).toBe(true);
      expect(lastLogger.readLogs).toHaveBeenCalled();
    });

    it("forwards INVALID_CURSOR to the wire (not generic LOGS_ERROR)", async () => {
      const api = await registerPlugin();
      const allOn = {
        connection: true, heartbeat: true, commands: true, dns: true,
        lifecycle: true,
        subscriptions: true, health: true, location: true, geofence: true,
      };
      const res = await invokeMethod(api, "betterclaw.logs", {
        settings: allOn, limit: 10, after: "!!!not-base64",
      });
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe("INVALID_CURSOR");
      expect(res.error?.message).toBe("cursor is malformed");
    });

    it("forwards CURSOR_EXPIRED to the wire (not generic LOGS_ERROR)", async () => {
      const { initDiagnosticLogger } = await import("../src/diagnostic-logger.js");
      const mockInit = initDiagnosticLogger as ReturnType<typeof vi.fn>;
      const api = await registerPlugin();
      const lastLogger = mockInit.mock.results[mockInit.mock.results.length - 1].value;
      const expiredError: Error & { code?: string } = Object.assign(
        new Error("cursor is no longer valid"),
        { code: "CURSOR_EXPIRED" },
      );
      lastLogger.readLogs.mockRejectedValueOnce(expiredError);

      const allOn = {
        connection: true, heartbeat: true, commands: true, dns: true,
        lifecycle: true,
        subscriptions: true, health: true, location: true, geofence: true,
      };
      // Use a well-formed cursor so decodeCursor passes; the mocked readLogs
      // is what rejects with CURSOR_EXPIRED.
      const cursor = Buffer.from(JSON.stringify({ ts: 1, idx: 0 }), "utf8").toString("base64");
      const res = await invokeMethod(api, "betterclaw.logs", {
        settings: allOn, limit: 10, after: cursor,
      });
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe("CURSOR_EXPIRED");
      expect(res.error?.message).toBe("cursor is no longer valid");
    });
  });

  // -------------------------------------------------------------------------
  // betterclaw.learn
  // -------------------------------------------------------------------------
  describe("betterclaw.learn", () => {
    it("rejects concurrent learn requests", async () => {
      const { runLearner } = await import("../src/learner.js");

      // Make runLearner hang
      let resolveHang: () => void;
      const hangPromise = new Promise<void>((r) => { resolveHang = r; });
      (runLearner as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
        await hangPromise;
      });

      const api = await registerPlugin();
      // Fire first learn (will hang)
      const firstLearnPromise = invokeMethod(api, "betterclaw.learn");
      // Give it a moment to enter the handler
      await new Promise((r) => setTimeout(r, 50));

      // Fire second learn — should be rejected as already-running
      const secondRes = await invokeMethod(api, "betterclaw.learn");
      expect(secondRes.result.ok).toBe(false);
      expect(secondRes.result.error).toBe("already-running");

      // Clean up: resolve the hanging learner
      resolveHang!();
      await firstLearnPromise;
      (runLearner as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    });
  });

  // -------------------------------------------------------------------------
  // betterclaw.config
  // -------------------------------------------------------------------------
  describe("betterclaw.config", () => {
    it("applies pushBudgetPerDay", async () => {
      const api = await registerPlugin();
      const res = await invokeMethod(api, "betterclaw.config", { pushBudgetPerDay: 25 });
      expect(res.ok).toBe(true);
      expect(res.result.applied).toBe(true);

      // Verify it persisted to device-config.json
      const raw = await fs.readFile(path.join(tmpDir, "device-config.json"), "utf8");
      const config = JSON.parse(raw);
      expect(config.pushBudgetPerDay).toBe(25);
    });

    it("applies proactiveEnabled", async () => {
      const api = await registerPlugin();
      const res = await invokeMethod(api, "betterclaw.config", { proactiveEnabled: false });
      expect(res.ok).toBe(true);

      const raw = await fs.readFile(path.join(tmpDir, "device-config.json"), "utf8");
      const config = JSON.parse(raw);
      expect(config.proactiveEnabled).toBe(false);
    });

    it("handles config save failure gracefully", async () => {
      // ContextManager.save() catches errors internally and returns false.
      // The config RPC handler calls save() but doesn't check the return value,
      // so it still responds with applied:true. Verify the file is not updated.
      const readOnlyDir = path.join(tmpDir, "readonly");
      await fs.mkdir(readOnlyDir);
      await fs.writeFile(path.join(readOnlyDir, "context.json"), "{}", "utf8");
      await fs.writeFile(path.join(readOnlyDir, "device-config.json"), '{"pushBudgetPerDay":10}', "utf8");

      const api = mockApi();
      api.runtime.state.resolveStateDir = () => readOnlyDir;
      plugin.register(api as any);
      await vi.waitFor(() => { expect(api.registerGatewayMethod).toHaveBeenCalled(); }, { timeout: 500 });
      await new Promise((r) => setTimeout(r, 50));

      // Make files read-only so save will fail silently
      await fs.chmod(path.join(readOnlyDir, "context.json"), 0o444);
      await fs.chmod(path.join(readOnlyDir, "device-config.json"), 0o444);

      try {
        const handler = api._gatewayMethods.get("betterclaw.config")!;
        let response: { ok: boolean; result?: any; error?: any } | undefined;
        const respond = (ok: boolean, result?: any, error?: any) => {
          response = { ok, result, error };
        };
        await handler({ params: { pushBudgetPerDay: 99 }, respond, context: mockContext() });
        // Handler responds ok even when save fails (save catches internally)
        expect(response!.ok).toBe(true);

        // But the file should NOT have been updated (write was rejected)
        const raw = await fs.readFile(path.join(readOnlyDir, "device-config.json"), "utf8");
        const config = JSON.parse(raw);
        expect(config.pushBudgetPerDay).toBe(10); // unchanged
      } finally {
        await fs.chmod(path.join(readOnlyDir, "context.json"), 0o644);
        await fs.chmod(path.join(readOnlyDir, "device-config.json"), 0o644);
      }
    });

    it("ignores unknown fields", async () => {
      const api = await registerPlugin();
      const res = await invokeMethod(api, "betterclaw.config", { unknownField: "hello", pushBudgetPerDay: 15 });
      expect(res.ok).toBe(true);

      const raw = await fs.readFile(path.join(tmpDir, "device-config.json"), "utf8");
      const config = JSON.parse(raw);
      expect(config.pushBudgetPerDay).toBe(15);
      expect(config.unknownField).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // betterclaw.context
  // -------------------------------------------------------------------------
  describe("betterclaw.context", () => {
    it("returns all expected fields after ping", async () => {
      const api = await registerPlugin();
      await invokeMethod(api, "betterclaw.ping", { tier: "premium", smartMode: true });
      const res = await invokeMethod(api, "betterclaw.context");
      expect(res.ok).toBe(true);
      expect(res.result).toHaveProperty("tier", "premium");
      expect(res.result).toHaveProperty("smartMode", true);
      expect(res.result).toHaveProperty("activity");
      expect(res.result).toHaveProperty("trends");
      expect(res.result).toHaveProperty("decisions");
      expect(res.result).toHaveProperty("meta");
      expect(res.result).toHaveProperty("routines");
      expect(res.result).toHaveProperty("timestamps");
      expect(res.result.calibrating).toBeUndefined();
      expect(res.result.triageProfile).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // bc command
  // -------------------------------------------------------------------------
  describe("bc command", () => {
    it("formats location, zone, health, events into text (battery removed from output)", async () => {
      const api = await registerPlugin();
      // Set up full context via snapshots
      await invokeMethod(api, "betterclaw.snapshot", {
        battery: { level: 0.72, state: "unplugged", isLowPowerMode: false },
        location: { latitude: 48.1351, longitude: 11.5820 },
        health: { stepsToday: 12500 },
        geofence: { type: "enter", zoneName: "Office", latitude: 48.1, longitude: 11.5 },
      });

      const bcCmd = api._commands.find((c) => c.name === "bc");
      const result = bcCmd!.handler() as { text: string };
      expect(result.text).not.toContain("Battery");
      expect(result.text).toContain("Location: Office");
      expect(result.text).toContain("Zone: Office");
      expect(result.text).toContain("12,500");
      expect(result.text).toContain("Events today:");
    });

    it("shows coordinates when no label", async () => {
      const api = await registerPlugin();
      await invokeMethod(api, "betterclaw.snapshot", {
        location: { latitude: 48.1351, longitude: 11.5820 },
      });

      const bcCmd = api._commands.find((c) => c.name === "bc");
      const result = bcCmd!.handler() as { text: string };
      // No zone set, so location label is null — should show coordinates
      expect(result.text).toContain("48.1351");
      expect(result.text).toContain("11.5820");
    });

    it("handles empty context", async () => {
      const api = await registerPlugin();
      const bcCmd = api._commands.find((c) => c.name === "bc");
      const result = bcCmd!.handler() as { text: string };
      // Should at least have the events line
      expect(result.text).toContain("Events today: 0");
      expect(result.text).toContain("Pushes: 0");
    });
  });

  // -------------------------------------------------------------------------
  // Background service
  // -------------------------------------------------------------------------
  describe("background service", () => {
    // Spy on PatternEngine.prototype.startSchedule to capture the daily callback
    // that the service passes in start().
    async function captureDailyCallback() {
      const { PatternEngine } = await import("../src/patterns.js");
      let capturedCallback: (() => Promise<void>) | undefined;
      vi.spyOn(PatternEngine.prototype, "startSchedule").mockImplementation(function (this: any, _hour: number, cb?: () => Promise<void>) {
        capturedCallback = cb;
      });
      return { getCb: () => capturedCallback };
    }

    it("registerService wires start/stop", async () => {
      const api = await registerPlugin();
      const svc = api._services.find((s) => s.id === "betterclaw-engine");
      expect(svc).toBeDefined();
      expect(typeof svc!.start).toBe("function");
      expect(typeof svc!.stop).toBe("function");
    });

    it("start triggers startSchedule (pattern engine runs initial compute)", async () => {
      const { getCb } = await captureDailyCallback();
      const api = await registerPlugin();
      const svc = api._services.find((s) => s.id === "betterclaw-engine")!;
      svc.start();
      // startSchedule should have been called and captured the callback
      expect(getCb()).toBeTypeOf("function");
      svc.stop();
    });

    it("daily callback runs log rotation regardless of smartMode", async () => {
      const { initDiagnosticLogger } = await import("../src/diagnostic-logger.js");
      const mockInit = initDiagnosticLogger as ReturnType<typeof vi.fn>;

      const { getCb } = await captureDailyCallback();
      const api = await registerPlugin();
      // Set to free tier (smartMode off)
      await invokeMethod(api, "betterclaw.ping", { tier: "free", smartMode: false });

      const svc = api._services.find((s) => s.id === "betterclaw-engine")!;
      svc.start();

      const loggerInstance = mockInit.mock.results[mockInit.mock.results.length - 1].value;
      loggerInstance.rotate.mockClear();

      // Actually invoke the daily callback
      await getCb()!();

      expect(loggerInstance.rotate).toHaveBeenCalledTimes(1);
      svc.stop();
    });

    it("daily callback runs reaction scanning and learner when smartMode on", async () => {
      const { scanPendingReactions: mockScan } = await import("../src/reaction-scanner.js");
      const { runLearner: mockRunLearner } = await import("../src/learner.js");
      (mockScan as ReturnType<typeof vi.fn>).mockClear();
      (mockRunLearner as ReturnType<typeof vi.fn>).mockClear();

      const { getCb } = await captureDailyCallback();
      const api = await registerPlugin();
      await invokeMethod(api, "betterclaw.ping", { tier: "premium", smartMode: true });

      const svc = api._services.find((s) => s.id === "betterclaw-engine")!;
      svc.start();

      // Actually invoke the daily callback
      await getCb()!();

      expect(mockScan).toHaveBeenCalledTimes(1);
      expect(mockRunLearner).toHaveBeenCalledTimes(1);
      svc.stop();
    });

    it("daily callback skips scanning and learner when smartMode off", async () => {
      const { scanPendingReactions: mockScan } = await import("../src/reaction-scanner.js");
      const { runLearner: mockRunLearner } = await import("../src/learner.js");
      (mockScan as ReturnType<typeof vi.fn>).mockClear();
      (mockRunLearner as ReturnType<typeof vi.fn>).mockClear();

      const { getCb } = await captureDailyCallback();
      const api = await registerPlugin();
      await invokeMethod(api, "betterclaw.ping", { tier: "free", smartMode: false });

      const svc = api._services.find((s) => s.id === "betterclaw-engine")!;
      svc.start();

      // Actually invoke the daily callback
      await getCb()!();

      // Log rotation still runs (verified in separate test)
      // But scanning and learner should be skipped
      expect(mockScan).not.toHaveBeenCalled();
      expect(mockRunLearner).not.toHaveBeenCalled();
      svc.stop();
    });
  });

  // -------------------------------------------------------------------------
  // Async init
  // -------------------------------------------------------------------------
  describe("async init", () => {
    it("degrades gracefully when context load fails (corrupt JSON)", async () => {
      // Write corrupt context.json before registering
      await fs.writeFile(path.join(tmpDir, "context.json"), "NOT VALID JSON", "utf8");

      const api = await registerPlugin();
      // Plugin should still work — context falls back to empty
      const bcCmd = api._commands.find((c) => c.name === "bc");
      const result = bcCmd!.handler() as { text: string };
      expect(result.text).toContain("Events today: 0");
    });

    it("continues when cooldown restore fails (corrupt events.jsonl)", async () => {
      // Write corrupt events file before registering
      await fs.writeFile(path.join(tmpDir, "events.jsonl"), "NOT VALID JSONL\n{broken}", "utf8");

      const api = await registerPlugin();
      // Plugin should still work
      const res = await invokeMethod(api, "betterclaw.ping", { tier: "free", smartMode: false });
      expect(res.ok).toBe(true);
      expect(res.result.ok).toBe(true);
    });
  });
});
