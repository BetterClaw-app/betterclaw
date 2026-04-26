import * as fs from "node:fs/promises";
import * as path from "node:path";
import { BETTERCLAW_COMMANDS } from "./cli.js";

type MaybeNode = Record<string, unknown>;

type PruneResult = {
  checked: number;
  prunedNodeIds: string[];
  prunedDeviceIds: string[];
  kept: number;
};

const BETTERCLAW_IOS_CLIENT_ID = "openclaw-ios";
const STALE_NODE_GRACE_MS = 2 * 60 * 1000;
const BETTERCLAW_COMMAND_SET = new Set(BETTERCLAW_COMMANDS);

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalized(value: unknown): string {
  return stringValue(value)?.toLowerCase() ?? "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function nodeIdFor(node: MaybeNode): string | undefined {
  return stringValue(node.nodeId) ?? stringValue(node.deviceId);
}

function isIosLike(node: MaybeNode): boolean {
  const platform = normalized(node.platform);
  const family = normalized(node.deviceFamily);
  const displayName = normalized(node.displayName);
  return platform.includes("ios") || family === "iphone" || family === "ipad" || displayName.includes("iphone");
}

function hasBetterClawCommandShape(node: MaybeNode): boolean {
  const commands = stringArray(node.commands);
  return commands.some((command) => BETTERCLAW_COMMAND_SET.has(command));
}

function isConnectedBetterClawIosNode(node: MaybeNode): boolean {
  return stringValue(node.clientId) === BETTERCLAW_IOS_CLIENT_ID && isIosLike(node);
}

function isPairedBetterClawIosNode(node: MaybeNode): boolean {
  return isIosLike(node) && hasBetterClawCommandShape(node);
}

function isPairedBetterClawIosDevice(node: MaybeNode): boolean {
  return stringValue(node.clientId) === BETTERCLAW_IOS_CLIENT_ID
    && stringArray(node.roles).includes("node")
    && isIosLike(node);
}

function matchesConnectedSignature(candidate: MaybeNode, connected: MaybeNode): boolean {
  const candidateModel = stringValue(candidate.modelIdentifier);
  const connectedModel = stringValue(connected.modelIdentifier);
  if (candidateModel && connectedModel && candidateModel !== connectedModel) return false;

  const candidateFamily = normalized(candidate.deviceFamily);
  const connectedFamily = normalized(connected.deviceFamily);
  if (candidateFamily && connectedFamily && candidateFamily !== connectedFamily) return false;

  const candidatePlatform = normalized(candidate.platform);
  const connectedPlatform = normalized(connected.platform);
  if (candidatePlatform && connectedPlatform) {
    const bothIos = candidatePlatform.includes("ios") && connectedPlatform.includes("ios");
    if (!bothIos && candidatePlatform !== connectedPlatform) return false;
  }

  return true;
}

function isPastGracePeriod(candidate: MaybeNode, newestConnectedAtMs: number): boolean {
  const lastSeen = Math.max(
    numberValue(candidate.lastConnectedAtMs) ?? 0,
    numberValue(candidate.approvedAtMs) ?? 0,
    numberValue(candidate.createdAtMs) ?? 0,
  );
  return lastSeen === 0 || lastSeen < newestConnectedAtMs - STALE_NODE_GRACE_MS;
}

async function readPairingFile(filePath: string): Promise<Record<string, MaybeNode> | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, MaybeNode>
      : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

async function writePairingFile(filePath: string, nodes: Record<string, MaybeNode>): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmpPath, `${JSON.stringify(nodes, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, filePath);
}

export async function pruneStaleBetterClawIosNodes(
  stateDir: string,
  connectedNodes: MaybeNode[],
): Promise<PruneResult> {
  const connectedBetterClawNodes = connectedNodes.filter(isConnectedBetterClawIosNode);
  if (connectedBetterClawNodes.length === 0) {
    return { checked: 0, prunedNodeIds: [], prunedDeviceIds: [], kept: 0 };
  }

  const newestConnectedAtMs = Math.max(
    Date.now(),
    ...connectedBetterClawNodes.map((node) => numberValue(node.connectedAtMs) ?? 0),
  );
  const connectedNodeIds = new Set(connectedBetterClawNodes.map(nodeIdFor).filter(Boolean));

  const pruneFile = async (
    relativePath: string,
    isBetterClawIosEntry: (node: MaybeNode) => boolean,
  ): Promise<{ checked: number; kept: number; pruned: string[] }> => {
    const filePath = path.join(stateDir, relativePath);
    const paired = await readPairingFile(filePath);
    if (!paired) return { checked: 0, kept: 0, pruned: [] };

    const pruned: string[] = [];
    for (const [entryId, node] of Object.entries(paired)) {
      const id = nodeIdFor(node) ?? entryId;
      if (connectedNodeIds.has(id)) continue;
      if (!isBetterClawIosEntry(node)) continue;
      if (!connectedBetterClawNodes.some((connected) => matchesConnectedSignature(node, connected))) continue;
      if (!isPastGracePeriod(node, newestConnectedAtMs)) continue;

      delete paired[entryId];
      pruned.push(id);
    }

    if (pruned.length > 0) {
      await writePairingFile(filePath, paired);
    }

    return {
      checked: Object.keys(paired).length + pruned.length,
      kept: Object.keys(paired).length,
      pruned,
    };
  };

  const [nodeResult, deviceResult] = await Promise.all([
    pruneFile(path.join("nodes", "paired.json"), isPairedBetterClawIosNode),
    pruneFile(path.join("devices", "paired.json"), isPairedBetterClawIosDevice),
  ]);

  return {
    checked: nodeResult.checked + deviceResult.checked,
    prunedNodeIds: nodeResult.pruned,
    prunedDeviceIds: deviceResult.pruned,
    kept: nodeResult.kept + deviceResult.kept,
  };
}
