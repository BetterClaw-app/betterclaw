import { vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { PluginModuleLogger } from "../src/types.js";

/** Noop logger for tests that don't need to assert on log output. */
export const noopLogger: PluginModuleLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** Mock logger with vi.fn() spies — use when asserting that errors/warnings were logged. */
export function mockLogger(): PluginModuleLogger & { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** Create a temp directory for test isolation. Call in beforeEach. */
export async function makeTmpDir(prefix: string = "betterclaw-test-"): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}
