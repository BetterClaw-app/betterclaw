import { redactEntry, MANIFEST, type ExportSettings, type RedactedEntry } from "./redactor.js";
import type { PluginDiagnosticLogger } from "./diagnostic-logger.js";

export type CursorState = { ts: number; idx: number };

export function encodeCursor(state: CursorState): string {
  return Buffer.from(JSON.stringify(state), "utf8").toString("base64");
}

export function decodeCursor(s: string): CursorState {
  let decoded: string;
  try {
    decoded = Buffer.from(s, "base64").toString("utf8");
  } catch {
    throw new Error("INVALID_CURSOR");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw new Error("INVALID_CURSOR");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as any).ts !== "number" ||
    typeof (parsed as any).idx !== "number"
  ) {
    throw new Error("INVALID_CURSOR");
  }
  return parsed as CursorState;
}

/**
 * Handle the `betterclaw.logs` RPC.
 *
 * @param params.settings      Per-category include/exclude flags (10 booleans).
 * @param params.since         Optional window lower bound, Unix seconds.
 * @param params.until         Optional window upper bound, Unix seconds.
 * @param params.limit         Optional per-page cap; default 500.
 * @param params.after         Optional opaque cursor from a previous response.
 * @param dlog                 The PluginDiagnosticLogger instance (from initDiagnosticLogger).
 * @param key                  HMAC key for redaction strategies. Required when any
 *                             sensitive category is enabled.
 *
 * Returns entries in ASC order (oldest first). `cursor` is set when there
 * are more entries beyond this page; pass it back as `after` to continue.
 * `truncated` flags a raw-read saturation at the 50k ceiling (anomaly only).
 *
 * The `entries` field is a plain JSON string in Task 4; Task 5 will wrap
 * it in base64(gzip(...)) for iOS tunnel friendliness. The wire type stays
 * `string` across both tasks.
 */
export type LogsRpcParams = {
  settings?: ExportSettings;
  since?: number;
  until?: number;
  limit?: number;
  anonymizationKey?: string;
  after?: string;
};

export type LogsRpcError = { code: string; message: string };

/**
 * Resolve the HMAC key to use for this RPC call, given the caller's params
 * and the plugin-local fallback key. Returns either the key to use or an
 * error object suitable for `respond(false, undefined, err)`.
 *
 * SECURITY: error messages are static strings; they intentionally never
 * echo the submitted `anonymizationKey` value.
 */
export function resolveAnonymizationKey(
  params: LogsRpcParams,
  fallback: Buffer,
): { key: Buffer } | { error: LogsRpcError } {
  if (params.anonymizationKey === undefined) return { key: fallback };
  if (typeof params.anonymizationKey !== "string") {
    return { error: { code: "INVALID_KEY", message: "anonymizationKey must be a string" } };
  }
  // Buffer.from with "base64" silently strips invalid characters rather
  // than throwing, so the length check below is the real gate on malformed
  // base64. The explicit typeof guard above handles unvalidated RPC input
  // where the caller sent a non-string value.
  const decoded = Buffer.from(params.anonymizationKey, "base64");
  if (decoded.length !== 32) {
    return { error: { code: "INVALID_KEY", message: "anonymizationKey must decode to 32 bytes" } };
  }
  return { key: decoded };
}

export async function handleLogsRpc(
  params: {
    settings: ExportSettings;
    since?: number;
    until?: number;
    limit?: number;
    after?: string;
  },
  dlog: PluginDiagnosticLogger,
  key: Buffer,
): Promise<{
  schemaVersion: 1;
  manifestVersion: number;
  entries: string;
  cursor: string | null;
  truncated: boolean;
}> {
  const limit = params.limit ?? 500;

  // Decode cursor if present. Throws Error("INVALID_CURSOR") which propagates
  // out through the RPC catch at index.ts and turns into the wire error.
  // (Task 7 tightens the thrown message; not a Task 4 concern.)
  let skipUntil: { ts: number; idx: number } | undefined;
  if (params.after !== undefined) {
    skipUntil = decodeCursor(params.after);
  }

  const { entries: raw, _cursorState } = await dlog.readLogs({
    since: params.since,
    until: params.until,
    limit,
    skipUntil,
  });

  // readLogs returns entries in ASC order (oldest first); apply settings
  // filter + redaction in that same order. The ordering is now the server's
  // contract per I2.
  const redacted: RedactedEntry[] = [];
  for (const e of raw) {
    const r = redactEntry(e, params.settings, key);
    if (r !== null) redacted.push(r);
  }

  // Plugin-internal RAW_CEILING saturation — readLogs caps at 50k via its
  // own Math.min. A full page reaching 50k is an anomaly worth flagging.
  // With the 500 default, this never trips in normal operation; cursor is
  // the "more exists" signal instead.
  const truncated = raw.length >= 50_000;

  const cursor = _cursorState ? encodeCursor(_cursorState) : null;

  return {
    schemaVersion: 1,
    manifestVersion: MANIFEST.manifestVersion,
    entries: JSON.stringify(redacted),
    cursor,
    truncated,
  };
}
