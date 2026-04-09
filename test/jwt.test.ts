import { describe, it, expect } from "vitest";
import { verifyJwt, type JwtPayload } from "../src/jwt.js";
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
