export interface JwtPayload {
  sub: string;
  aud: string;
  ent: string[];
  iat: number;
  exp: number;
  iss: string;
}

const EXPECTED_AUD = "betterclaw";
const EXPECTED_ISS = "api.betterclaw.app";

function base64urlDecode(str: string): Uint8Array {
  const padded = str + "=".repeat((4 - (str.length % 4)) % 4);
  const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function importPublicKey(pem: string): Promise<CryptoKey> {
  const b64 = pem
    .replace(/-----BEGIN PUBLIC KEY-----/, "")
    .replace(/-----END PUBLIC KEY-----/, "")
    .replace(/\s/g, "");
  const binary = atob(b64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "spki",
    bytes,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"]
  );
}

/**
 * Verify an ES256 JWT and return the payload, or null if invalid.
 * Never throws — all failures return null and are logged.
 */
export async function verifyJwt(
  token: string,
  publicKeyPem: string
): Promise<JwtPayload | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const [headerB64, payloadB64, signatureB64] = parts;

    // Verify signature
    const publicKey = await importPublicKey(publicKeyPem);
    const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const signature = base64urlDecode(signatureB64);

    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      signature as Uint8Array<ArrayBuffer>,
      signingInput
    );
    if (!valid) return null;

    // Decode and validate payload
    const payload: JwtPayload = JSON.parse(
      new TextDecoder().decode(base64urlDecode(payloadB64))
    );

    if (payload.aud !== EXPECTED_AUD) return null;
    if (payload.iss !== EXPECTED_ISS) return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (!Array.isArray(payload.ent)) return null;

    return payload;
  } catch {
    return null;
  }
}

/**
 * Check if a verified JWT payload has a specific entitlement.
 */
export function hasEntitlement(
  payload: JwtPayload | null,
  entitlement: string
): boolean {
  return payload !== null && payload.ent.includes(entitlement);
}

// ES256 public key for JWT verification (from betterclaw-api)
const JWT_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAENEZHoGBTF5wHq6p7GTDRl5b24aSS
Jw9NZAbe/inE4VynwiMvl3IxS+CdJYSm4CKbeCGXxy/5jCBk6Mzod+0ICg==
-----END PUBLIC KEY-----`;

// Module-level JWT state — safe because this is per-plugin-instance,
// not per-request. Updated only from the heartbeat handler.
let currentJwtToken: string | null = null;
let currentPayload: JwtPayload | null = null;

/**
 * Store and verify a JWT received from heartbeat.
 * Only re-verifies if the token has changed.
 */
export async function storeJwt(jwt: string): Promise<JwtPayload | null> {
  if (jwt === currentJwtToken) return currentPayload;
  currentJwtToken = jwt;
  currentPayload = await verifyJwt(jwt, JWT_PUBLIC_KEY);
  return currentPayload;
}

/**
 * Get the current verified payload (may be null).
 */
export function getVerifiedPayload(): JwtPayload | null {
  return currentPayload;
}

/**
 * Check if the current JWT grants an entitlement.
 * Returns null if entitled, or an error message string if not.
 */
export function requireEntitlement(entitlement: string): string | null {
  if (!currentPayload) {
    return "This feature requires an active Premium subscription. Please open BetterClaw and check your subscription status.";
  }
  if (!hasEntitlement(currentPayload, entitlement)) {
    if (entitlement === "shortcuts") {
      return "This feature requires the Shortcuts Pack add-on. Please open BetterClaw and check your subscription status.";
    }
    return "This feature requires an active Premium subscription. Please open BetterClaw and check your subscription status.";
  }
  return null;
}

/**
 * Reset JWT state (for testing).
 */
export function _resetJwtState(): void {
  currentJwtToken = null;
  currentPayload = null;
}

/**
 * Inject a payload directly (for testing requireEntitlement without real keys).
 */
export function _setPayloadForTesting(payload: JwtPayload | null): void {
  currentPayload = payload;
}
