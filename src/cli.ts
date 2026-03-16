export const BETTERCLAW_COMMANDS = [
  "clipboard.write",
  "device.battery",
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
  "shortcuts.run",
  "subscribe.add",
  "subscribe.list",
  "subscribe.pause",
  "subscribe.remove",
  "subscribe.resume",
  "system.capabilities",
  "system.notify",
].sort();

export function mergeAllowCommands(existing: string[], toAdd: string[]): string[] {
  const set = new Set([...existing, ...toAdd]);
  return [...set].sort();
}
