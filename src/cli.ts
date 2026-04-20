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

export function mergeAllowCommands(existing: string[], toAdd: string[]): string[] {
  const set = new Set([...existing, ...toAdd]);
  return [...set].sort();
}

export function mergeAlsoAllow(existing: string[], toAdd: string[]): string[] {
  const set = new Set([...existing, ...toAdd]);
  return [...set];
}
