// src/routing/rule-matcher.ts
import type { DeviceEvent } from "../types.js";
import type { Rule, RuleMatchResult, RuleMatchFields } from "./types.js";

/** Match rules in order, first match wins. Returns null if no rule matches. */
export function matchEvent(event: DeviceEvent, rules: Rule[]): RuleMatchResult | null {
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    if (matches(event, rule)) {
      return { rule, index: i, action: rule.action };
    }
  }
  return null;
}

function matches(event: DeviceEvent, rule: Rule): boolean {
  if (rule.match === "*") return true;
  const m = rule.match as RuleMatchFields;

  if (m.source !== undefined && m.source !== event.source) return false;

  if (m.type !== undefined) {
    const want = m.type === "enter" ? 1 : 0;
    if (event.data?.type !== want) return false;
  }

  if (m.geofenceLabel !== undefined) {
    if (event.metadata?.zoneName !== m.geofenceLabel) return false;
  }

  if (m.level !== undefined) {
    const val = event.data?.level;
    if (typeof val !== "number") return false;
    if (!evalComparison(val, m.level)) return false;
  }

  return true;
}

const OPS = ["<=", ">=", "==", "<", ">"] as const;

function evalComparison(value: number, expr: string): boolean {
  const trimmed = expr.trim();
  for (const op of OPS) {
    if (trimmed.startsWith(op)) {
      const rhs = parseFloat(trimmed.slice(op.length).trim());
      if (Number.isNaN(rhs)) return false;
      switch (op) {
        case "<=": return value <= rhs;
        case ">=": return value >= rhs;
        case "==": return value === rhs;
        case "<":  return value < rhs;
        case ">":  return value > rhs;
      }
    }
  }
  return false;
}
