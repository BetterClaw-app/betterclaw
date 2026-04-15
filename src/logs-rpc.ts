import { redactEntry, MANIFEST, type ExportSettings, type RedactedEntry } from "./redactor.js";
import type { PluginDiagnosticLogger } from "./diagnostic-logger.js";

/**
 * Handle the `betterclaw.logs` RPC.
 *
 * @param params.settings      Per-category include/exclude flags (10 booleans).
 * @param params.since         Optional window lower bound, Unix seconds.
 * @param params.until         Optional window upper bound, Unix seconds.
 * @param params.limit         Optional cap on returned entries; default 10_000.
 * @param dlog                 The PluginDiagnosticLogger instance (from initDiagnosticLogger).
 * @param key                  HMAC key for redaction strategies. Required when any
 *                             sensitive category is enabled.
 *
 * Returns entries newest-first. `truncated` is set if either:
 *  - the post-filter count exceeded `limit` (older matches dropped to preserve recency), or
 *  - the raw read saturated the 50k ceiling (older pre-filter entries dropped by readLogs).
 * In both cases the caller knows "there's more than you got."
 */
export async function handleLogsRpc(
  params: {
    settings: ExportSettings;
    since?: number;
    until?: number;
    limit?: number;
  },
  dlog: PluginDiagnosticLogger,
  key: Buffer,
): Promise<{
  schemaVersion: number;
  manifestVersion: number;
  entries: RedactedEntry[];
  truncated: boolean;
}> {
  const limit = params.limit ?? 10_000;
  const RAW_CEILING = 50_000;

  const { entries: raw } = await dlog.readLogs({
    since: params.since,
    limit: RAW_CEILING,
  });
  const rawSaturated = raw.length >= RAW_CEILING;

  const redacted: RedactedEntry[] = [];
  let postFilterCount = 0;

  for (let i = raw.length - 1; i >= 0; i--) {
    const e = raw[i];
    if (params.until !== undefined && e.timestamp > params.until) continue;

    const r = redactEntry(e, params.settings, key);
    if (r === null) continue;
    postFilterCount++;
    if (redacted.length < limit) redacted.push(r);
  }

  return {
    schemaVersion: 1,
    manifestVersion: MANIFEST.manifestVersion,
    entries: redacted,
    truncated: postFilterCount > limit || rawSaturated,
  };
}
