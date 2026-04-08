import { describe, it, expect, beforeEach } from "vitest";
import * as path from "node:path";
import { PluginDiagnosticLogger } from "../src/diagnostic-logger.js";
import { mockLogger, makeTmpDir } from "./helpers.js";

describe("betterclaw.logs RPC response shape", () => {
  let dlog: PluginDiagnosticLogger;

  beforeEach(async () => {
    const logDir = path.join(await makeTmpDir(), "logs");
    dlog = new PluginDiagnosticLogger(logDir, mockLogger());
    dlog.info("plugin.pipeline", "push.sent", "test event", { subscriptionId: "test" });
    dlog.warn("plugin.rpc", "ping.error", "test warning");
    await dlog.flush();
  });

  it("returns entries and total matching RPC response shape", async () => {
    const result = await dlog.readLogs({ level: "warn", limit: 10 });
    expect(result).toHaveProperty("entries");
    expect(result).toHaveProperty("total");
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].level).toBe("warn");
  });

  it("source prefix filter works", async () => {
    const result = await dlog.readLogs({ source: "plugin.pipeline" });
    expect(result.entries).toHaveLength(1);
  });

  it("returns empty for no matches", async () => {
    const result = await dlog.readLogs({ source: "nonexistent" });
    expect(result.entries).toHaveLength(0);
    expect(result.total).toBe(0);
  });
});
