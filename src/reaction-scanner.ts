import type { ReactionStatus } from "./types.js";
import type { ReactionTracker } from "./reactions.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { errorMessage } from "./types.js";
import { dlog } from "./diagnostic-logger.js";

// --- Types ---

export interface PushMatch {
  pushIndex: number;
  subsequentMessages: Array<{ role: string; content: unknown }>;
}

export interface ClassificationResult {
  status: ReactionStatus;
  reason: string;
}

export interface ScanDeps {
  api: OpenClawPluginApi;
  reactions: ReactionTracker;
}

// --- Helpers ---

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text ?? "")
      .join("");
  }
  return "";
}

function isBetterClawPush(text: string): boolean {
  return text.includes("[BetterClaw device event");
}

// --- Exported functions ---

/**
 * Deterministic search: find the pushed message in the session transcript by
 * timestamp proximity (within 30s) + content prefix match.
 */
export function findPushInMessages(
  messages: Array<{ role: string; content: unknown; timestamp?: number }>,
  pushedAt: number,
  messageSummary: string,
): PushMatch | null {
  const prefix = messageSummary.slice(0, 30);

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const text = extractText(msg.content);

    // Must be a BetterClaw push message
    if (!isBetterClawPush(text)) continue;

    // Must be within 30s of pushedAt
    if (msg.timestamp !== undefined) {
      if (Math.abs(msg.timestamp - pushedAt) > 30) continue;
    }

    // Must contain the first 30 chars of messageSummary
    if (!text.includes(prefix)) continue;

    // Collect subsequent messages until next BetterClaw push or limit of 5
    const subsequent: Array<{ role: string; content: unknown }> = [];
    for (let j = i + 1; j < messages.length && subsequent.length < 5; j++) {
      const next = messages[j];
      const nextText = extractText(next.content);
      if (isBetterClawPush(nextText)) break;
      subsequent.push({ role: next.role, content: next.content });
    }

    return { pushIndex: i, subsequentMessages: subsequent };
  }

  return null;
}

/**
 * Build a classification prompt asking the LLM to determine engagement status.
 */
export function buildClassificationPrompt(
  pushMessage: string,
  subsequentMessages: Array<{ role: string; content: unknown }>,
): string {
  const convoLines = subsequentMessages
    .map((m) => `${m.role}: ${extractText(m.content)}`)
    .join("\n");

  return `You are classifying user engagement with a pushed device notification.

The following message was pushed to the user's AI assistant:
---
${pushMessage}
---

Conversation that followed:
${convoLines || "(no subsequent messages)"}

Classify the user's engagement with this notification:
- "engaged": the user acknowledged, replied, or acted on the notification
- "ignored": the user changed topic, ignored it, or showed no reaction
- "unclear": not enough information to determine

Respond with JSON: {"status": "engaged"|"ignored"|"unclear", "reason": string}`;
}

/**
 * Parse LLM JSON response into classification result.
 */
export function parseClassificationResponse(text: string): ClassificationResult {
  try {
    const cleaned = text.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    const validStatuses: ReactionStatus[] = ["engaged", "ignored", "unclear"];
    const status = validStatuses.includes(parsed.status) ? parsed.status : "unclear";
    return {
      status,
      reason: typeof parsed.reason === "string" ? parsed.reason : "no reason provided",
    };
  } catch {
    return { status: "unclear", reason: "failed to parse LLM response" };
  }
}

/**
 * Orchestrator: scan all pending reactions, do deterministic transcript search,
 * classify via LLM, and record results on the ReactionTracker.
 */
export async function scanPendingReactions(deps: ScanDeps): Promise<void> {
  const { api, reactions } = deps;

  let classified = 0;
  let skipped = 0;

  const pending = reactions.getPending();
  if (pending.length === 0) {
    dlog.debug("plugin.reactions", "scan.empty", "no pending reactions to classify");
    return;
  }

  dlog.info("plugin.reactions", "scan.started", "scanning pending reactions", { pendingCount: pending.length });

  // Fetch session messages once (limit 200) to search through
  let messages: Array<{ role: string; content: unknown; timestamp?: number }> = [];
  try {
    const { messages: fetched } = await api.runtime.subagent.getSessionMessages({
      sessionKey: "main",
      limit: 200,
    });
    messages = fetched as typeof messages;
  } catch (err) {
    const msg = errorMessage(err);
    dlog.error("plugin.reactions", "scan.error", "failed to fetch session messages", { error: msg });
    return;
  }

  for (const reaction of pending) {
    try {
      // Step 1: Deterministic search
      const match = findPushInMessages(messages, reaction.pushedAt, reaction.messageSummary);
      if (!match) {
        skipped++;
        dlog.info("plugin.reactions", "scan.skipped", "no transcript match for reaction", { subscriptionId: reaction.subscriptionId, pushedAt: reaction.pushedAt });
        continue;
      }

      // Step 2: Build prompt
      const pushText = extractText(
        messages[match.pushIndex].content,
      );
      const prompt = buildClassificationPrompt(pushText, match.subsequentMessages);

      // Step 3: LLM classification via subagent
      const sessionKey = `betterclaw-classify-${reaction.subscriptionId}-${Math.floor(reaction.pushedAt)}`;
      let classificationResult: ClassificationResult = { status: "unclear", reason: "classification not attempted" };

      try {
        // Clean up any stale session first
        try { await api.runtime.subagent.deleteSession({ sessionKey }); } catch { /* ignore */ }

        const { runId } = await api.runtime.subagent.run({
          sessionKey,
          message: prompt,
          deliver: false,
          idempotencyKey: `classify-${reaction.subscriptionId}-${Math.floor(reaction.pushedAt)}`,
        });

        await api.runtime.subagent.waitForRun({ runId, timeoutMs: 30000 });

        const { messages: classifyMessages } = await api.runtime.subagent.getSessionMessages({
          sessionKey,
          limit: 5,
        });

        const lastAssistant = (classifyMessages as any[]).filter((m) => m.role === "assistant").pop();
        if (lastAssistant) {
          const content = extractText(lastAssistant.content);
          if (content) {
            classificationResult = parseClassificationResponse(content);
          }
        }
      } finally {
        try { await api.runtime.subagent.deleteSession({ sessionKey }); } catch { /* ignore */ }
      }

      // Step 4: Record classification using compound key
      reactions.classify(
        reaction.subscriptionId,
        reaction.pushedAt,
        classificationResult.status,
        classificationResult.reason,
      );

      classified++;
      dlog.info("plugin.reactions", "classified", "reaction classified", { subscriptionId: reaction.subscriptionId, status: classificationResult.status, reason: classificationResult.reason });
    } catch (err) {
      const msg = errorMessage(err);
      dlog.error("plugin.reactions", "classified.error", "error classifying reaction", { subscriptionId: reaction.subscriptionId, error: msg });
    }
  }

  dlog.info("plugin.reactions", "scan.completed", "reaction scan finished", { classified, skipped });

  // Persist updated reactions (save is self-catching)
  await reactions.save();
}
