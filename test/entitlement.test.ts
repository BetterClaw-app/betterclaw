import { describe, it, expect, beforeEach } from "vitest";
import { storeJwt, requireEntitlement, getVerifiedPayload, _resetJwtState, _setPayloadForTesting } from "../src/jwt";
import type { JwtPayload } from "../src/jwt";

// Reuse test helpers from jwt.test.ts
async function generateTestKeyPair() {
  return crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
}

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

const now = Math.floor(Date.now() / 1000);
const premiumPayload: JwtPayload = {
  sub: "test-device",
  aud: "betterclaw",
  ent: ["premium"],
  iat: now,
  exp: now + 3600,
  iss: "api.betterclaw.app",
};

const fullPayload: JwtPayload = {
  sub: "test-device",
  aud: "betterclaw",
  ent: ["premium", "shortcuts"],
  iat: now,
  exp: now + 3600,
  iss: "api.betterclaw.app",
};

describe("Entitlement gating", () => {
  beforeEach(() => {
    _resetJwtState();
  });

  it("blocks premium features when no JWT stored", () => {
    const err = requireEntitlement("premium");
    expect(err).toContain("Premium subscription");
  });

  it("blocks shortcuts when no JWT stored", () => {
    const err = requireEntitlement("shortcuts");
    expect(err).toContain("Premium subscription");
  });

  it("allows premium features with valid premium JWT", () => {
    _setPayloadForTesting(premiumPayload);
    expect(requireEntitlement("premium")).toBeNull();
  });

  it("blocks shortcuts when only premium entitlement", () => {
    _setPayloadForTesting(premiumPayload);
    const err = requireEntitlement("shortcuts");
    expect(err).toContain("Shortcuts Pack");
  });

  it("allows shortcuts with shortcuts entitlement", () => {
    _setPayloadForTesting(fullPayload);
    expect(requireEntitlement("shortcuts")).toBeNull();
  });

  it("storeJwt rejects JWT signed with wrong key", async () => {
    const keyPair = await generateTestKeyPair();
    const token = await signTestJwt(
      { sub: "d", aud: "betterclaw", ent: ["premium"], iat: now, exp: now + 3600, iss: "api.betterclaw.app" },
      keyPair.privateKey
    );
    const result = await storeJwt(token);
    expect(result).toBeNull();
    expect(requireEntitlement("premium")).not.toBeNull();
  });

  it("getVerifiedPayload returns null when no JWT", () => {
    expect(getVerifiedPayload()).toBeNull();
  });

  it("getVerifiedPayload returns payload when set", () => {
    _setPayloadForTesting(premiumPayload);
    expect(getVerifiedPayload()).toEqual(premiumPayload);
  });
});
