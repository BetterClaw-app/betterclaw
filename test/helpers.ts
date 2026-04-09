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

/** Create a temp directory for test isolation. Dirs are auto-cleaned by OS in /tmp.
 *  For explicit cleanup, use `afterEach(() => fs.rm(dir, { recursive: true, force: true }).catch(() => {}))`. */
export async function makeTmpDir(prefix: string = "betterclaw-test-"): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Generate an ES256 key pair for JWT tests. */
export async function generateTestKeyPair() {
  return crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
}

/** Sign a test JWT with an ES256 private key. */
export async function signTestJwt(
  payload: Record<string, unknown>,
  privateKey: CryptoKey,
  kid = "v1"
): Promise<string> {
  const header = { alg: "ES256", kid };
  const encode = (obj: unknown) => {
    const json = JSON.stringify(obj);
    const b64 = btoa(json);
    return b64.replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  };
  const headerB64 = encode(header);
  const payloadB64 = encode(payload);
  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    signingInput
  );
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${headerB64}.${payloadB64}.${sigB64}`;
}

/** Export a CryptoKey to PEM format for the JWT verifier. */
export async function exportPublicKeyPem(publicKey: CryptoKey): Promise<string> {
  const exported = await crypto.subtle.exportKey("spki", publicKey);
  const b64 = btoa(String.fromCharCode(...new Uint8Array(exported)));
  return `-----BEGIN PUBLIC KEY-----\n${b64}\n-----END PUBLIC KEY-----`;
}
