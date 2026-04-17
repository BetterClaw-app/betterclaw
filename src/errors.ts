/**
 * Extract structured error fields matching the iOS `errorFields(_:)` shape.
 * Keys use the dotted `error.*` prefix — an explicit carve-out from the
 * camelCase data-key rule, documented in docs/logging-schema.md.
 */
export function errorFields(err: unknown): Record<string, unknown> {
  return walk(err, new WeakSet(), 0);
}

const MAX_CAUSE_DEPTH = 8;

// Matches any absolute path ending in `/betterclaw-plugin/` (the repo root).
// Node stack frames embed absolute filesystem paths like
// `/Users/max/Documents/VSC_Projects/betterclaw-plugin/src/pipeline.ts:167:5`,
// which leak the developer's layout when exported. Scrubbing reduces these to
// `<repo>/src/pipeline.ts:167:5` while leaving function names, line numbers,
// and non-repo frames (node internals, node_modules) intact.
const REPO_ROOT_RE = /(?:\/[^\s:()]+)*\/betterclaw-plugin\//g;

export function scrubStack(stack: string): string {
  return stack.replace(REPO_ROOT_RE, "<repo>/");
}

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
    if (typeof err.stack === "string") out["error.stack"] = scrubStack(err.stack);
    const maybeCode = (err as { code?: unknown }).code;
    if (typeof maybeCode === "string") {
      out["error.code"] = maybeCode;
    }
    if (err.cause !== undefined && depth < MAX_CAUSE_DEPTH) {
      out["error.cause"] = walk(err.cause, seen, depth + 1);
    }
    return out;
  }

  out["error.type"] = typeof err;
  out["error.message"] = String(err);
  return out;
}
