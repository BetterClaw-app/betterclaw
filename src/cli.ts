export const BETTERCLAW_COMMANDS = [
  "clipboard.write",
  "geofence.add",
  "geofence.list",
  "geofence.remove",
  "health.distance",
  "health.heartrate",
  "health.hrv",
  "health.restinghr",
  "health.sleep",
  "health.steps",
  "health.summary",
  "health.workouts",
  "location.get",
  "shortcuts.install",
  "shortcuts.registry.get",
  "shortcuts.run",
  "subscribe.add",
  "subscribe.list",
  "subscribe.pause",
  "subscribe.remove",
  "subscribe.resume",
  "system.capabilities",
  "system.notify",
].sort();

export const BETTERCLAW_TOOLS = ["check_tier", "get_context", "edit_routing_rules"];

export type AgentProfileMode = "yes" | "no" | "prompt";

export function mergeAllowCommands(existing: string[], toAdd: string[]): string[] {
  const set = new Set([...existing, ...toAdd]);
  return [...set].sort();
}

export function mergeAlsoAllow(existing: string[], toAdd: string[]): string[] {
  const set = new Set([...existing, ...toAdd]);
  return [...set];
}

export function normalizeAgentProfileMode(value: unknown): AgentProfileMode {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (raw === "" || raw === "prompt") return "prompt";
  if (["yes", "y", "true", "1", "on"].includes(raw)) return "yes";
  if (["no", "n", "false", "0", "off"].includes(raw)) return "no";
  throw new Error("Invalid --agent-profile value. Expected yes, no, or prompt.");
}

export async function resolveAgentProfileConsent(input: {
  mode: AgentProfileMode;
  yes?: boolean;
  isTTY: boolean;
  ask: () => Promise<boolean>;
}): Promise<boolean> {
  if (input.mode === "yes") return true;
  if (input.mode === "no") return false;
  if (input.yes) return true;
  if (!input.isTTY) return false;
  return await input.ask();
}
