// src/routing/patch-applier.ts
import type { RoutingRules, JsonPatchOp } from "./types.js";

export interface ApplyResult {
  result: RoutingRules;
  applied: JsonPatchOp[];
  dropped: Array<{ op: JsonPatchOp; reason: string }>;
}

/** Apply a JSON Patch with locked-key filtering. Syntax errors reject the whole patch. */
export function applyPatch(
  current: RoutingRules,
  patch: JsonPatchOp[],
  lockedKeys: Set<string>,
): ApplyResult {
  const dropped: Array<{ op: JsonPatchOp; reason: string }> = [];
  const acceptable: JsonPatchOp[] = [];

  for (const op of patch) {
    if (lockedKeys.has(op.path)) {
      dropped.push({ op, reason: "locked by user edit" });
      continue;
    }
    acceptable.push(op);
  }

  // Attempt to apply all acceptable ops against a deep clone; if any single op fails,
  // reject the entire patch (return original + all acceptable marked as dropped).
  const clone: RoutingRules = JSON.parse(JSON.stringify(current));
  try {
    for (const op of acceptable) {
      applyOp(clone, op);
    }
  } catch (err) {
    return {
      result: current,
      applied: [],
      dropped: [
        ...dropped,
        ...acceptable.map(op => ({ op, reason: `patch rejected: ${(err as Error).message}` })),
      ],
    };
  }

  return { result: clone, applied: acceptable, dropped };
}

function applyOp(doc: unknown, op: JsonPatchOp): void {
  const parts = parsePath(op.path);
  if (parts.length === 0) throw new Error("cannot operate on root");
  const parentPath = parts.slice(0, -1);
  const key = parts[parts.length - 1];
  const parent = resolveRef(doc, parentPath);

  if (Array.isArray(parent)) {
    if (op.op === "add") {
      if (key === "-") parent.push(op.value);
      else {
        const idx = parseInt(key, 10);
        if (Number.isNaN(idx) || idx < 0 || idx > parent.length) throw new Error(`bad array index: ${key}`);
        parent.splice(idx, 0, op.value);
      }
      return;
    }
    if (op.op === "remove" || op.op === "replace") {
      const idx = parseInt(key, 10);
      if (Number.isNaN(idx) || idx < 0 || idx >= parent.length) throw new Error(`bad array index: ${key}`);
      if (op.op === "remove") parent.splice(idx, 1);
      else parent[idx] = op.value;
      return;
    }
    throw new Error(`unsupported op: ${op.op}`);
  }

  if (typeof parent === "object" && parent !== null) {
    const rec = parent as Record<string, unknown>;
    if (op.op === "add" || op.op === "replace") {
      // replace requires the key to exist; add is permissive
      if (op.op === "replace" && !(key in rec)) throw new Error(`path does not exist: ${op.path}`);
      rec[key] = op.value;
      return;
    }
    if (op.op === "remove") {
      if (!(key in rec)) throw new Error(`path does not exist: ${op.path}`);
      delete rec[key];
      return;
    }
  }
  throw new Error(`cannot apply op at: ${op.path}`);
}

function parsePath(p: string): string[] {
  if (p === "") return [];
  if (!p.startsWith("/")) throw new Error(`path must start with /: ${p}`);
  return p.slice(1).split("/").map(decodeSegment);
}

function decodeSegment(s: string): string {
  return s.replace(/~1/g, "/").replace(/~0/g, "~");
}

function resolveRef(doc: unknown, parts: string[]): unknown {
  let ref: unknown = doc;
  for (const p of parts) {
    if (Array.isArray(ref)) {
      const idx = parseInt(p, 10);
      if (Number.isNaN(idx) || idx < 0 || idx >= ref.length) throw new Error(`bad array index: ${p}`);
      ref = ref[idx];
    } else if (typeof ref === "object" && ref !== null) {
      ref = (ref as Record<string, unknown>)[p];
      if (ref === undefined) throw new Error(`path segment missing: ${p}`);
    } else {
      throw new Error(`cannot descend into non-container at: ${p}`);
    }
  }
  return ref;
}
