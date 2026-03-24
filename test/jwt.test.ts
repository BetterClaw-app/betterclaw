import { describe, it, expect } from "vitest";
import { verifyJwt, type JwtPayload } from "../src/jwt";

// Generate a test ES256 key pair for tests
async function generateTestKeyPair() {
  return crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
}

// Helper: sign a test JWT
async function signTestJwt(
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

// Export the public key as PEM for the verifier
async function exportPublicKeyPem(publicKey: CryptoKey): Promise<string> {
  const exported = await crypto.subtle.exportKey("spki", publicKey);
  const b64 = btoa(String.fromCharCode(...new Uint8Array(exported)));
  return `-----BEGIN PUBLIC KEY-----\n${b64}\n-----END PUBLIC KEY-----`;
}

describe("JWT verification", () => {
  it("verifies a valid JWT", async () => {
    const keyPair = await generateTestKeyPair();
    const pem = await exportPublicKeyPem(keyPair.publicKey);
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      sub: "test-device",
      aud: "betterclaw",
      ent: ["premium"],
      iat: now,
      exp: now + 3600,
      iss: "api.betterclaw.app",
    };
    const token = await signTestJwt(payload, keyPair.privateKey);
    const result = await verifyJwt(token, pem);
    expect(result).not.toBeNull();
    expect(result!.ent).toEqual(["premium"]);
  });

  it("rejects expired JWT", async () => {
    const keyPair = await generateTestKeyPair();
    const pem = await exportPublicKeyPem(keyPair.publicKey);
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      sub: "test-device",
      aud: "betterclaw",
      ent: ["premium"],
      iat: now - 7200,
      exp: now - 3600,
      iss: "api.betterclaw.app",
    };
    const token = await signTestJwt(payload, keyPair.privateKey);
    const result = await verifyJwt(token, pem);
    expect(result).toBeNull();
  });

  it("rejects JWT with wrong audience", async () => {
    const keyPair = await generateTestKeyPair();
    const pem = await exportPublicKeyPem(keyPair.publicKey);
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      sub: "test-device",
      aud: "wrong",
      ent: ["premium"],
      iat: now,
      exp: now + 3600,
      iss: "api.betterclaw.app",
    };
    const token = await signTestJwt(payload, keyPair.privateKey);
    const result = await verifyJwt(token, pem);
    expect(result).toBeNull();
  });

  it("rejects tampered JWT", async () => {
    const keyPair = await generateTestKeyPair();
    const pem = await exportPublicKeyPem(keyPair.publicKey);
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      sub: "test-device",
      aud: "betterclaw",
      ent: ["premium"],
      iat: now,
      exp: now + 3600,
      iss: "api.betterclaw.app",
    };
    const token = await signTestJwt(payload, keyPair.privateKey);
    // Tamper with payload
    const parts = token.split(".");
    const tampered = btoa(JSON.stringify({ ...payload, ent: ["premium", "shortcuts"] }))
      .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    const bad = `${parts[0]}.${tampered}.${parts[2]}`;
    const result = await verifyJwt(bad, pem);
    expect(result).toBeNull();
  });

  it("returns null for garbage input", async () => {
    const keyPair = await generateTestKeyPair();
    const pem = await exportPublicKeyPem(keyPair.publicKey);
    const result = await verifyJwt("not.a.jwt", pem);
    expect(result).toBeNull();
  });

  it("checks premium entitlement", async () => {
    const keyPair = await generateTestKeyPair();
    const pem = await exportPublicKeyPem(keyPair.publicKey);
    const now = Math.floor(Date.now() / 1000);
    const token = await signTestJwt(
      { sub: "d", aud: "betterclaw", ent: ["premium"], iat: now, exp: now + 3600, iss: "api.betterclaw.app" },
      keyPair.privateKey
    );
    const result = await verifyJwt(token, pem);
    expect(result!.ent).toContain("premium");
    expect(result!.ent).not.toContain("shortcuts");
  });
});
