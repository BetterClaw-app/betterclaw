import { describe, it, expect, beforeEach } from "vitest";
import { verifyJwt, storeJwt, requireEntitlement, getVerifiedPayload, _resetJwtState, _setPayloadForTesting } from "../src/jwt.js";
import type { JwtPayload } from "../src/jwt.js";
import { generateTestKeyPair, signTestJwt, exportPublicKeyPem } from "./helpers.js";

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

// Use a fixed far-future timestamp to avoid drift in watch mode
const TEST_IAT = 2000000000; // ~2033
const premiumPayload: JwtPayload = {
  sub: "test-device",
  aud: "betterclaw",
  ent: ["premium"],
  iat: TEST_IAT,
  exp: TEST_IAT + 3600,
  iss: "api.betterclaw.app",
};

const fullPayload: JwtPayload = {
  sub: "test-device",
  aud: "betterclaw",
  ent: ["premium", "shortcuts"],
  iat: TEST_IAT,
  exp: TEST_IAT + 3600,
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
      { sub: "d", aud: "betterclaw", ent: ["premium"], iat: TEST_IAT, exp: TEST_IAT + 3600, iss: "api.betterclaw.app" },
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
