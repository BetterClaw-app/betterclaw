import * as fs from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("package metadata", () => {
  it("keeps the OpenClaw manifest version in sync with package.json", async () => {
    const [packageJson, pluginJson] = await Promise.all([
      fs.readFile("package.json", "utf8").then(JSON.parse),
      fs.readFile("openclaw.plugin.json", "utf8").then(JSON.parse),
    ]);

    expect(pluginJson.version).toBe(packageJson.version);
  });
});
