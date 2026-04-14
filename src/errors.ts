/**
 * Extract structured error fields matching the iOS `errorFields(_:)` shape.
 * Keys use the dotted `error.*` prefix — an explicit carve-out from the
 * camelCase data-key rule, documented in docs/logging-schema.md.
 */
export function errorFields(err: unknown): Record<string, unknown> {
  return walk(err, new WeakSet(), 0);
}

const MAX_CAUSE_DEPTH = 8;

function walk(err: unknown, seen: WeakSet<object>, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  if (err instanceof Error) {
    if (seen.has(err)) {
      out["error.type"] = err.constructor.name;
      out["error.message"] = "<cycle>";
      return out;
    }
    seen.add(err);
    out["error.type"] = err.constructor.name;
    out["error.message"] = err.message;
    if (typeof err.stack === "string") out["error.stack"] = err.stack;
    if (err.cause !== undefined && depth < MAX_CAUSE_DEPTH) {
      out["error.cause"] = walk(err.cause, seen, depth + 1);
    }
    return out;
  }

  out["error.type"] = typeof err;
  out["error.message"] = String(err);
  return out;
}
