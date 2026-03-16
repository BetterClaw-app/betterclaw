# Review Bug Fixes Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 26 bugs found by 7 independent code reviewers after the plugin smart mode rework.

**Architecture:** Seven groups of fixes applied sequentially. Each group is a coherent commit touching related files. No new files created — all fixes are modifications to existing code.

**Tech Stack:** TypeScript, Vitest

**Spec:** `docs/specs/2026-03-16-review-bugfixes-design.md`

**Working directory:** `~/Documents/VSC_Projects/betterclaw-plugin/.worktrees/smart-mode-rework`

**Test command:** `npx vitest run`

---

## File Structure

### Modified Files

| File | Changes |
|------|---------|
| `src/types.ts` | Remove `"defer"` from FilterDecision and EventLogEntry |
| `src/filter.ts` | Change defer → drop for daily health; add budgetOverride param |
| `src/pipeline.ts` | pushToAgent returns boolean; reorder records after push; remove defer branch; apply device config budget |
| `src/triage.ts` | Fix model extraction for multi-slash; fix time format |
| `src/learner.ts` | Session cleanup; remove extraSystemPrompt; yesterday's memory; local date; content blocks; enum validation; loadTriageProfile validation; idempotencyKey; mkdir |
| `src/index.ts` | Remove "received" pre-log; try-catch on RPCs; tier validation; null timestamps; init restructure; config race comment |
| `src/reactions.ts` | Per-line parse resilience; mkdir in save |
| `src/events.ts` | Per-line parse resilience; atomic rotation |
| `src/context.ts` | Local-time daily counter reset |
| `src/triggers.ts` | Check deviceConfig.proactiveEnabled |
| `test/filter.test.ts` | Update defer→drop test |
| `test/learner.test.ts` | Update readMemorySummary test for local date |
| `test/context.test.ts` | Update daily counter reset test |

---

## Chunk 1: Pipeline Flow, Types, and LLM Fixes

### Task 1: Remove "defer" and Fix Types

**Files:**
- Modify: `src/types.ts`
- Modify: `src/filter.ts`
- Modify: `src/pipeline.ts:86`
- Modify: `test/filter.test.ts`

- [ ] **Step 1: Update types.ts — remove "defer" from FilterDecision**

Replace the FilterDecision type:
```typescript
export type FilterDecision =
  | { action: "push"; reason: string }
  | { action: "drop"; reason: string }
  | { action: "ambiguous"; reason: string };
```

Update EventLogEntry decision union:
```typescript
decision: "push" | "drop" | "stored" | "received";
```

- [ ] **Step 2: Update filter.ts — change defer to drop**

In `evaluate()`, replace the daily health defer (line 68):
```typescript
// Before:
return { action: "defer", reason: "daily health summary — outside morning window" };

// After:
return { action: "drop", reason: "daily health summary — outside morning window" };
```

- [ ] **Step 3: Update pipeline.ts — remove defer branch from log mapping**

Replace line 86:
```typescript
// Before:
decision: decision.action === "push" ? "push" : decision.action === "defer" ? "defer" : "drop",

// After:
decision: decision.action === "push" ? "push" : "drop",
```

- [ ] **Step 4: Update test**

In `test/filter.test.ts`, find the test "defers daily health outside morning window" and update:
```typescript
// Change test name and expectation:
it("drops daily health outside morning window", () => {
  // ... same setup ...
  expect(decision.action).toBe("drop");
});
```

- [ ] **Step 5: Run tests and commit**

Run: `npx vitest run`
Expected: All pass

```bash
git add src/types.ts src/filter.ts src/pipeline.ts test/filter.test.ts
git commit -m "fix: remove defer action — daily health outside window is now dropped"
```

---

### Task 2: Fix pushToAgent and Pipeline Ordering

**Files:**
- Modify: `src/pipeline.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Make pushToAgent return boolean**

In `src/pipeline.ts`, change `pushToAgent` from `Promise<void>` to `Promise<boolean>`:
```typescript
async function pushToAgent(deps: PipelineDeps, event: DeviceEvent, reason: string): Promise<boolean> {
  const message = formatEnrichedMessage(event, deps.context);
  const idempotencyKey = `event-${event.subscriptionId}-${Math.floor(event.firedAt)}`;

  try {
    await deps.api.runtime.subagent.run({
      sessionKey: "main",
      message,
      deliver: true,
      idempotencyKey,
    });
    deps.api.logger.info(`betterclaw: pushed event ${event.subscriptionId} to agent`);
    return true;
  } catch (err) {
    deps.api.logger.error(
      `betterclaw: failed to push to agent: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}
```

- [ ] **Step 2: Replace the event logging + push block (lines 83-111)**

Replace everything from `// Log the event + decision` (line 83) through `await deps.reactions.save()` (line 111) with the following. This replaces BOTH the event log append AND the push block, since the new code handles logging within each branch:
```typescript
  if (decision.action === "push") {
    const pushed = await pushToAgent(deps, event, decision.reason);

    if (pushed) {
      rules.recordFired(event.subscriptionId, event.firedAt);
      context.recordPush();
      deps.reactions.recordPush({
        idempotencyKey: `event-${event.subscriptionId}-${Math.floor(event.firedAt)}`,
        subscriptionId: event.subscriptionId,
        source: event.source,
        pushedAt: Date.now() / 1000,
      });
    }

    await events.append({
      event,
      decision: pushed ? "push" : "drop",
      reason: pushed ? decision.reason : `push failed: ${decision.reason}`,
      timestamp: Date.now() / 1000,
    });
  } else {
    await events.append({
      event,
      decision: "drop",
      reason: decision.reason,
      timestamp: Date.now() / 1000,
    });
    api.logger.info(`betterclaw: drop event ${event.subscriptionId}: ${decision.reason}`);
  }

  // Persist context and reactions
  await context.save();
  await deps.reactions.save();
```

- [ ] **Step 3: Reorder the triage-push path (lines 56-80)**

Replace the triage result handling block with:
```typescript
    if (triageResult.push) {
      const pushed = await pushToAgent(deps, event, `triage: ${triageResult.reason}`);

      if (pushed) {
        rules.recordFired(event.subscriptionId, event.firedAt);
        context.recordPush();
        deps.reactions.recordPush({
          idempotencyKey: `event-${event.subscriptionId}-${Math.floor(event.firedAt)}`,
          subscriptionId: event.subscriptionId,
          source: event.source,
          pushedAt: Date.now() / 1000,
        });
      }

      await events.append({
        event,
        decision: pushed ? "push" : "drop",
        reason: pushed ? `triage: ${triageResult.reason}` : `triage push failed: ${triageResult.reason}`,
        timestamp: Date.now() / 1000,
      });
    } else {
      await events.append({
        event,
        decision: "drop",
        reason: `triage: ${triageResult.reason}`,
        timestamp: Date.now() / 1000,
      });
    }
```

- [ ] **Step 4: Remove the "received" pre-log from index.ts**

In `src/index.ts`, remove line 284:
```typescript
// DELETE this line:
await eventLog.append({ event, decision: "received", reason: "queued", timestamp: Date.now() / 1000 });
```

Also remove `"received"` from the `EventLogEntry.decision` union in `src/types.ts` since it's no longer used:
```typescript
decision: "push" | "drop" | "stored";
```

- [ ] **Step 5: Run tests and commit**

Run: `npx vitest run`
Expected: All pass

```bash
git add src/pipeline.ts src/index.ts src/types.ts
git commit -m "fix: pushToAgent returns boolean, reorder records after success, remove received pre-log"
```

---

### Task 3: Fix LLM Model String Handling

**Files:**
- Modify: `src/triage.ts`
- Modify: `src/pipeline.ts`

- [ ] **Step 1: Fix model name extraction in triage.ts**

Replace line 83-85:
```typescript
// Before:
const model = config.triageModel.includes("/")
  ? config.triageModel.split("/").pop()!
  : config.triageModel;

// After:
const model = config.triageModel.includes("/")
  ? config.triageModel.split("/").slice(1).join("/")
  : config.triageModel;
```

- [ ] **Step 2: Fix time format in triage prompt**

Replace line 31:
```typescript
// Before:
`Time: ${new Date().toLocaleTimeString()}`,

// After:
`Time: ${String(new Date().getHours()).padStart(2, "0")}:${String(new Date().getMinutes()).padStart(2, "0")}`,
```

- [ ] **Step 3: Fix provider extraction in pipeline.ts**

In the triage path's `resolveApiKey` callback, replace the provider extraction:
```typescript
// Before:
provider: deps.config.triageModel.split("/")[0] || "openai",

// After:
provider: deps.config.triageModel.includes("/")
  ? deps.config.triageModel.split("/")[0]
  : "openai",
```

- [ ] **Step 4: Run tests and commit**

Run: `npx vitest run`
Expected: All pass

```bash
git add src/triage.ts src/pipeline.ts
git commit -m "fix: handle multi-slash model names and bare model names in triage"
```

---

### Task 4: Learner Robustness

**Files:**
- Modify: `src/learner.ts`
- Modify: `test/learner.test.ts`

- [ ] **Step 1: Fix readMemorySummary to use local date**

Replace line 10:
```typescript
// Before:
const dateStr = date.toISOString().split("T")[0];

// After:
const y = date.getFullYear();
const m = String(date.getMonth() + 1).padStart(2, "0");
const d = String(date.getDate()).padStart(2, "0");
const dateStr = `${y}-${m}-${d}`;
```

- [ ] **Step 2: Fix runLearner to read yesterday's memory**

Replace line 124:
```typescript
// Before:
const memorySummary = await readMemorySummary(workspaceDir, new Date());

// After:
const yesterday = new Date();
yesterday.setDate(yesterday.getDate() - 1);
const memorySummary = await readMemorySummary(workspaceDir, yesterday)
  ?? await readMemorySummary(workspaceDir, new Date());
```

- [ ] **Step 3: Remove extraSystemPrompt, add instruction to prompt**

Replace lines 149-154 (subagent.run call):
```typescript
const { runId } = await api.runtime.subagent.run({
  sessionKey: "betterclaw-learn",
  message: prompt + "\n\nIMPORTANT: Respond with ONLY a JSON triage profile object. Do NOT call any tools.",
  deliver: false,
  idempotencyKey: `betterclaw-learn-${Date.now()}`,
});
```

- [ ] **Step 4: Add session cleanup — pre-delete and try/finally**

Restructure runLearner to clean up the session on start and ensure cleanup on exit. Replace the subagent block (steps 7-12) with:

```typescript
  // 7. Clean up any stale session from previous failed run
  try { await api.runtime.subagent.deleteSession({ sessionKey: "betterclaw-learn" }); } catch { /* ignore */ }

  // 8. Run subagent
  let newProfile: TriageProfile | null = null;
  try {
    const { runId } = await api.runtime.subagent.run({
      sessionKey: "betterclaw-learn",
      message: prompt + "\n\nIMPORTANT: Respond with ONLY a JSON triage profile object. Do NOT call any tools.",
      deliver: false,
      idempotencyKey: `betterclaw-learn-${Date.now()}`,
    });

    // 9. Wait for completion
    await api.runtime.subagent.waitForRun({ runId, timeoutMs: 60000 });

    // 10. Read response
    const messages = await api.runtime.subagent.getSessionMessages({
      sessionKey: "betterclaw-learn",
      limit: 5,
    });

    // 11. Parse last assistant message — handle both string and content-block formats
    const lastAssistant = messages.filter((m: any) => m.role === "assistant").pop();
    if (lastAssistant) {
      const content = typeof lastAssistant.content === "string"
        ? lastAssistant.content
        : Array.isArray(lastAssistant.content)
          ? lastAssistant.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("")
          : null;
      if (content) {
        newProfile = parseTriageProfile(content);
      }
    }
  } finally {
    // 12. Always delete session
    try { await api.runtime.subagent.deleteSession({ sessionKey: "betterclaw-learn" }); } catch { /* ignore */ }
  }

  // 13. Save if valid
  if (newProfile) {
    await saveTriageProfile(stateDir, newProfile);
  }

  // 14. Rotate old reactions
  reactions.rotate();
  await reactions.save();
```

- [ ] **Step 5: Validate enums in parseTriageProfile**

Replace line 82-86:
```typescript
// Before:
if (!parsed.summary || !parsed.interruptionTolerance) return null;
return {
  eventPreferences: parsed.eventPreferences ?? {},
  lifeContext: parsed.lifeContext ?? "",
  interruptionTolerance: parsed.interruptionTolerance,

// After:
if (!parsed.summary || !parsed.interruptionTolerance) return null;
const validTolerances = ["low", "normal", "high"];
return {
  eventPreferences: parsed.eventPreferences ?? {},
  lifeContext: parsed.lifeContext ?? "",
  interruptionTolerance: validTolerances.includes(parsed.interruptionTolerance)
    ? parsed.interruptionTolerance
    : "normal",
```

- [ ] **Step 6: Validate in loadTriageProfile**

Replace `loadTriageProfile`:
```typescript
export async function loadTriageProfile(stateDir: string): Promise<TriageProfile | null> {
  try {
    const content = await fs.readFile(path.join(stateDir, "triage-profile.json"), "utf-8");
    return parseTriageProfile(content);
  } catch {
    return null;
  }
}
```

- [ ] **Step 7: Add mkdir in saveTriageProfile**

```typescript
export async function saveTriageProfile(stateDir: string, profile: TriageProfile): Promise<void> {
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(path.join(stateDir, "triage-profile.json"), JSON.stringify(profile, null, 2), "utf-8");
}
```

- [ ] **Step 8: Update learner test for local date**

In `test/learner.test.ts`, the `readMemorySummary` test creates a file named `2026-03-16.md` and reads with `new Date("2026-03-16T10:00:00")`. After the local-date fix, `new Date("2026-03-16T10:00:00")` parsed WITHOUT a timezone suffix uses local time, so `getFullYear()`/`getMonth()`/`getDate()` will produce `2026-03-16`. No change needed if the test already uses a date string without `Z` suffix. Verify the test still passes.

- [ ] **Step 9: Run tests and commit**

Run: `npx vitest run`
Expected: All pass

```bash
git add src/learner.ts test/learner.test.ts
git commit -m "fix: learner session cleanup, local dates, content blocks, enum validation"
```

---

## Chunk 2: RPC Safety, Persistence, Timezone, and Device Config

### Task 5: RPC Error Handling and Contracts

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add try-catch to betterclaw.config handler**

Wrap the handler body:
```typescript
api.registerGatewayMethod("betterclaw.config", async ({ params, respond }) => {
  try {
    const update = params as Record<string, unknown>;
    const deviceConfig: DeviceConfig = {};

    if (typeof update.pushBudgetPerDay === "number") {
      deviceConfig.pushBudgetPerDay = update.pushBudgetPerDay;
    }
    if (typeof update.proactiveEnabled === "boolean") {
      deviceConfig.proactiveEnabled = update.proactiveEnabled;
    }

    ctxManager.setDeviceConfig(deviceConfig);
    await ctxManager.save();

    respond(true, { applied: true });
  } catch (err) {
    api.logger.error(`betterclaw.config error: ${err instanceof Error ? err.message : String(err)}`);
    respond(false, undefined, { code: "INTERNAL_ERROR", message: "config update failed" });
  }
});
```

- [ ] **Step 2: Add try-catch to betterclaw.context handler**

Wrap the entire handler body in try-catch with error respond. Also fix timestamps to default to `null`:

```typescript
const timestamps = {
  battery: ctxManager.getTimestamp("battery") ?? null,
  location: ctxManager.getTimestamp("location") ?? null,
  health: ctxManager.getTimestamp("health") ?? null,
  activity: ctxManager.getTimestamp("activity") ?? null,
  lastSnapshot: ctxManager.getTimestamp("lastSnapshot") ?? null,
};
```

Add catch:
```typescript
  } catch (err) {
    api.logger.error(`betterclaw.context error: ${err instanceof Error ? err.message : String(err)}`);
    respond(false, undefined, { code: "INTERNAL_ERROR", message: "context fetch failed" });
  }
```

- [ ] **Step 3: Add try-catch to betterclaw.snapshot handler**

Same pattern:
```typescript
api.registerGatewayMethod("betterclaw.snapshot", async ({ params, respond }) => {
  try {
    if (!initialized) await initPromise;
    // ... existing body ...
    respond(true, { applied: true });
  } catch (err) {
    api.logger.error(`betterclaw.snapshot error: ${err instanceof Error ? err.message : String(err)}`);
    respond(false, undefined, { code: "INTERNAL_ERROR", message: "snapshot apply failed" });
  }
});
```

- [ ] **Step 4: Validate tier in ping handler**

Replace lines 92-96:
```typescript
const validTiers: Array<"free" | "premium" | "premium+"> = ["free", "premium", "premium+"];
const rawTier = (params as Record<string, unknown>)?.tier as string;
const tier = validTiers.includes(rawTier as any) ? (rawTier as "free" | "premium" | "premium+") : "free";
const smartMode = (params as Record<string, unknown>)?.smartMode === true;

ctxManager.setRuntimeState({ tier, smartMode });
```

- [ ] **Step 5: Restructure init for resilience**

Replace the init block (lines 73-88):
```typescript
let initialized = false;
const initPromise = (async () => {
  try {
    await ctxManager.load();
    initialized = true;
  } catch (err) {
    api.logger.error(`betterclaw: context init failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    await reactionTracker.load();
  } catch (err) {
    api.logger.warn(`betterclaw: reaction tracker load failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }
  if (initialized) {
    try {
      const recentEvents = await eventLog.readSince(Date.now() / 1000 - 86400);
      rules.restoreCooldowns(
        recentEvents
          .filter((e) => e.decision === "push")
          .map((e) => ({ subscriptionId: e.event.subscriptionId, firedAt: e.event.firedAt })),
      );
      api.logger.info("betterclaw: async init complete");
    } catch (err) {
      api.logger.error(`betterclaw: cooldown restore failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
})();
```

- [ ] **Step 6: Add config race comment**

Add a comment above the `betterclaw.config` handler:
```typescript
// Note: config save runs outside the event queue. Concurrent saves with processEvent
// could race on context.json. Accepted risk — config changes are user-initiated and infrequent.
```

- [ ] **Step 7: Run tests and commit**

Run: `npx vitest run`
Expected: All pass

```bash
git add src/index.ts
git commit -m "fix: add try-catch to async RPCs, validate tier, null timestamps, resilient init"
```

---

### Task 6: Data Persistence Robustness

**Files:**
- Modify: `src/reactions.ts`
- Modify: `src/events.ts`

- [ ] **Step 1: Fix reactions.ts — per-line parse resilience and mkdir**

Replace `load()`:
```typescript
async load(): Promise<void> {
  try {
    const content = await fs.readFile(this.filePath, "utf-8");
    this.reactions = content
      .trim()
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try { return [JSON.parse(line) as ReactionEntry]; }
        catch { return []; }
      });
  } catch {
    this.reactions = [];
  }
}
```

Add mkdir to `save()`:
```typescript
async save(): Promise<void> {
  await fs.mkdir(path.dirname(this.filePath), { recursive: true });
  const lines = this.reactions.map((r) => JSON.stringify(r)).join("\n");
  await fs.writeFile(this.filePath, lines + "\n", "utf-8");
}
```

- [ ] **Step 2: Fix events.ts — per-line parse resilience**

Replace `readAll()`:
```typescript
async readAll(): Promise<EventLogEntry[]> {
  try {
    const raw = await fs.readFile(this.filePath, "utf8");
    return raw
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .flatMap((line) => {
        try { return [JSON.parse(line) as EventLogEntry]; }
        catch { return []; }
      });
  } catch {
    return [];
  }
}
```

- [ ] **Step 3: Fix events.ts — atomic rotation**

Replace `rotate()`:
```typescript
async rotate(): Promise<number> {
  const entries = await this.readAll();
  if (entries.length <= MAX_LINES) return 0;

  const cutoff = Date.now() / 1000 - MAX_AGE_MS / 1000;
  const kept = entries.filter((e) => e.timestamp >= cutoff).slice(-MAX_LINES);
  const removed = entries.length - kept.length;

  const content = kept.map((e) => JSON.stringify(e)).join("\n") + "\n";
  const tmpPath = this.filePath + ".tmp";
  await fs.writeFile(tmpPath, content, "utf8");
  await fs.rename(tmpPath, this.filePath);

  return removed;
}
```

- [ ] **Step 4: Run tests and commit**

Run: `npx vitest run`
Expected: All pass

```bash
git add src/reactions.ts src/events.ts
git commit -m "fix: per-line JSONL parse resilience, mkdir in reactions, atomic event rotation"
```

---

### Task 7: Timezone Consistency — Daily Counter Reset

**Files:**
- Modify: `src/context.ts`
- Modify: `test/context.test.ts`

- [ ] **Step 1: Fix daily boundary detection**

In `src/context.ts`, replace lines 82-83 in `updateFromEvent()`:
```typescript
// Before:
const lastDay = Math.floor(this.context.meta.lastEventAt / 86400);
const currentDay = Math.floor(now / 86400);

// After:
const lastDate = new Date(this.context.meta.lastEventAt * 1000);
const currentDate = new Date(now * 1000);
const lastDay = `${lastDate.getFullYear()}-${lastDate.getMonth()}-${lastDate.getDate()}`;
const currentDay = `${currentDate.getFullYear()}-${currentDate.getMonth()}-${currentDate.getDate()}`;
```

- [ ] **Step 2: Update the daily counter reset test**

In `test/context.test.ts`, the test "resets daily counters on day change" uses timestamps `1740000000`, `1740000100`, and `1740090000`. These are Unix timestamps — verify the test still produces different local dates (not just different UTC days). The gap between `1740000000` and `1740090000` is 90000s = 25 hours, which crosses a day boundary in any timezone. Test should still pass.

Run: `npx vitest run test/context.test.ts`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
git add src/context.ts test/context.test.ts
git commit -m "fix: daily counter reset uses local midnight instead of UTC midnight"
```

---

### Task 8: Device Config Application

**Files:**
- Modify: `src/filter.ts`
- Modify: `src/pipeline.ts`
- Modify: `src/triggers.ts`

- [ ] **Step 1: Add budgetOverride parameter to RulesEngine.evaluate**

In `src/filter.ts`, update the `evaluate` method signature:
```typescript
evaluate(event: DeviceEvent, context: DeviceContext, budgetOverride?: number): FilterDecision {
```

Update the budget check (line 72):
```typescript
// Before:
if (context.meta.pushesToday >= this.pushBudget) {

// After:
const budget = budgetOverride ?? this.pushBudget;
if (context.meta.pushesToday >= budget) {
  return { action: "drop", reason: `push budget exhausted (${context.meta.pushesToday}/${budget} today)` };
```

- [ ] **Step 2: Pass device config budget in pipeline.ts**

In `processEvent()`, after the smartMode check, compute effective budget and pass to evaluate:
```typescript
// After the smartMode check, before rules.evaluate:
const deviceConfig = context.getDeviceConfig();
const effectiveBudget = deviceConfig.pushBudgetPerDay ?? config.pushBudgetPerDay;

// Update the rules.evaluate call:
const decision = rules.evaluate(event, context.get(), effectiveBudget);
```

- [ ] **Step 3: Check deviceConfig.proactiveEnabled in triggers.ts**

In `checkAll()`, after the smartMode check (line 192-194), add:
```typescript
if (!this.context.getRuntimeState().smartMode) {
  return;
}
const deviceConfig = this.context.getDeviceConfig();
if (deviceConfig.proactiveEnabled === false) {
  return;
}
```

- [ ] **Step 4: Run tests and commit**

Run: `npx vitest run`
Expected: All pass

```bash
git add src/filter.ts src/pipeline.ts src/triggers.ts
git commit -m "fix: apply device config overrides to budget check and proactive triggers"
```

---

## Reviewer Fixes Applied

All 26 issues addressed across 7 groups:
- Group 1 (Tasks 1-2): #1 double log, #9 push failure, #10 defer→drop, #22 ordering
- Group 2 (Task 3): #2 multi-slash model, #3 provider fallback, #26 locale time
- Group 3 (Task 4): #5 session leak, #6 stale session, #7 extraSystemPrompt, #12 yesterday's memory, #14 UTC date, #16 content blocks, #19 enum validation, #20 loadTriageProfile, #27 idempotencyKey, #24 mkdir (learner)
- Group 4 (Task 5): #4 missing try-catch, #15 tier validation, #21 undefined timestamps, #25 initialized flag, #18 config race (documented)
- Group 5 (Task 6): #8 JSONL resilience, #17 rotation race, #24 mkdir (reactions)
- Group 6 (Task 7): #13 UTC midnight reset
- Group 7 (Task 8): #11 device config not applied
