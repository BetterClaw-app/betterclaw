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
      signature,
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
