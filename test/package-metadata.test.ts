import * as fs from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("package metadata", () => {
  it("keeps OpenClaw package metadata publishable", async () => {
    const [packageJson, pluginJson] = await Promise.all([
      fs.readFile("package.json", "utf8").then(JSON.parse),
      fs.readFile("openclaw.plugin.json", "utf8").then(JSON.parse),
    ]);

    expect(pluginJson.version).toBe(packageJson.version);
    expect(packageJson.main).toBe("./dist/index.js");
    expect(packageJson.types).toBe("./dist/index.d.ts");
    expect(pluginJson.main).toBe("dist/index.js");
    expect(packageJson.openclaw.extensions).toEqual(["./dist/index.js"]);
    expect(packageJson.openclaw.runtimeExtensions).toEqual(["./dist/index.js"]);
    expect(packageJson.openclaw.install.minHostVersion).toBe(">=2026.5.5");
    expect(pluginJson.activation).toEqual({ onStartup: true });
    expect(pluginJson.contracts.tools).toEqual([
      "check_tier",
      "get_context",
      "edit_routing_rules",
    ]);
    expect(packageJson.files).toContain("dist/");
    expect(packageJson.scripts.prepack).toBe("npm run build");
  });
});
