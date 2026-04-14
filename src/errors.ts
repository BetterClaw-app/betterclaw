/**
 * Extract structured error fields matching the iOS `errorFields(_:)` shape.
 * Keys use the dotted `error.*` prefix — an explicit carve-out from the
 * camelCase data-key rule, documented in docs/logging-schema.md.
 */
export function errorFields(err: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  if (err instanceof Error) {
    out["error.type"] = err.constructor.name;
    out["error.message"] = err.message;
    if (typeof err.stack === "string") out["error.stack"] = err.stack;
    if (err.cause !== undefined) out["error.cause"] = errorFields(err.cause);
    return out;
  }

  out["error.type"] = typeof err;
  out["error.message"] = String(err);
  return out;
}
