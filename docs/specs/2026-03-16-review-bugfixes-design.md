# Plugin Smart Mode Rework — Review Bug Fixes

**Goal:** Fix 27 issues found by 7 independent code reviewers after the initial 20-task implementation.

**Working directory:** `~/Documents/VSC_Projects/betterclaw-plugin/.worktrees/smart-mode-rework`

**Test command:** `npx vitest run`

---

## Group 1: Event Log & Pipeline Flow

**Issues:** #1 (double event log), #9 (failed push consumes budget), #10 (defer is silent drop), #22 (inconsistent ordering)

### Changes

**`src/index.ts`** — Remove the `eventLog.append({ decision: "received" })` call before `respond()` in the `betterclaw.event` handler. The "received" safety log was creating duplicate entries for every event, inflating stats and polluting the Context tab. There is no recovery code that reads "received" entries, so the safety guarantee was theoretical.

**`src/pipeline.ts`** — Reorder `recordFired()` and `recordPush()` to happen AFTER successful `pushToAgent()`, not before. This applies to both the direct-push path and the triage-push path. If `pushToAgent` fails, the budget is not consumed and the cooldown is not set, allowing the next occurrence to retry naturally. Unify ordering: both paths should follow the same sequence: push → record reaction → record fired → record push → log.

**`src/filter.ts`** — Change daily health summary outside morning window from `{ action: "defer" }` to `{ action: "drop", reason: "daily health summary — outside morning window" }`. Remove "defer" from the `FilterDecision` type union.

**`src/types.ts`** — Remove `"defer"` from `EventLogEntry.decision` union. Update `FilterDecision` to remove the defer variant.

**`test/filter.test.ts`** — Update the test "defers daily health outside morning window" to expect "drop" instead of "defer".

---

## Group 2: LLM & Model String Handling

**Issues:** #2 (multi-slash model names), #3 (provider fallback), #26 (locale-dependent time)

### Changes

**`src/triage.ts`** — Fix model name extraction:
```typescript
// Before (broken for "together/meta-llama/Llama-3.1-8B"):
const model = config.triageModel.includes("/")
  ? config.triageModel.split("/").pop()!
  : config.triageModel;

// After:
const model = config.triageModel.includes("/")
  ? config.triageModel.split("/").slice(1).join("/")
  : config.triageModel;
```

Fix time format in prompt from `new Date().toLocaleTimeString()` to explicit 24h format:
```typescript
const now = new Date();
const timeStr = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
```

**`src/pipeline.ts`** — Fix provider extraction for bare model names:
```typescript
// Before (never falls back for "gpt-4o-mini"):
provider: deps.config.triageModel.split("/")[0] || "openai"

// After:
provider: deps.config.triageModel.includes("/")
  ? deps.config.triageModel.split("/")[0]
  : "openai"
```

---

## Group 3: Learner Robustness

**Issues:** #5 (session leak), #6 (stale session), #7 (extraSystemPrompt), #12 (read yesterday's memory), #14 (UTC date), #16 (content type), #19 (enum validation), #20 (loadTriageProfile validation), #27 (missing idempotencyKey)

### Changes

**`src/learner.ts`** — Multiple fixes:

1. **Session cleanup (try/finally + pre-delete):** Wrap the subagent calls in try/finally that always deletes the session. Also delete the session at the START of runLearner to clean up any stale session from a previous failed run.

2. **Remove `extraSystemPrompt`:** This is not a documented SDK parameter. Move the instruction into the message text itself (append to the prompt).

3. **Read yesterday's memory:** Change `readMemorySummary` call to use yesterday's date since the learner runs at 5am when today's summary barely exists. Also try today's as fallback.
```typescript
const yesterday = new Date();
yesterday.setDate(yesterday.getDate() - 1);
const memorySummary = await readMemorySummary(workspaceDir, yesterday)
  ?? await readMemorySummary(workspaceDir, new Date());
```

4. **Use local date in readMemorySummary:** Replace `date.toISOString().split("T")[0]` with local date formatting to avoid UTC date mismatch.

5. **Handle content blocks:** When reading subagent response, handle both string content and array-of-blocks content:
```typescript
const content = typeof lastAssistant.content === "string"
  ? lastAssistant.content
  : Array.isArray(lastAssistant.content)
    ? lastAssistant.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("")
    : null;
```

6. **Validate enums in parseTriageProfile:** Check `interruptionTolerance` is one of "low" | "normal" | "high". Default invalid values to "normal".

7. **Validate in loadTriageProfile:** Run `parseTriageProfile(content)` instead of raw `JSON.parse` cast, so disk profiles get the same validation as LLM responses.

8. **Add idempotencyKey:** Add `idempotencyKey: \`betterclaw-learn-${Date.now()}\`` to the subagent.run call.

---

## Group 4: RPC Error Handling & Contracts

**Issues:** #4 (missing try-catch), #15 (tier validation), #21 (undefined timestamps), #25 (initialized flag)

### Changes

**`src/index.ts`** — Multiple fixes:

1. **Add try-catch to async RPC handlers:** Wrap `betterclaw.config`, `betterclaw.context`, and `betterclaw.snapshot` handlers in try-catch blocks that call `respond(false, undefined, { code: "INTERNAL_ERROR", message: ... })` on error.

2. **Validate tier in ping:** Whitelist valid tier values:
```typescript
const validTiers = ["free", "premium", "premium+"] as const;
const rawTier = (params as Record<string, unknown>)?.tier as string;
const tier = validTiers.includes(rawTier as any) ? rawTier as typeof validTiers[number] : "free";
```

3. **Default timestamps to null:** In `betterclaw.context` handler, default each timestamp to `null` instead of leaving as `undefined` (which gets omitted from JSON):
```typescript
battery: ctxManager.getTimestamp("battery") ?? null,
```

4. **Fix initialized flag:** Restructure init so that each load is independent and `initialized` is set based on critical loads (ctxManager) succeeding, with reactionTracker failure being non-fatal:
```typescript
try {
  await ctxManager.load();
  initialized = true;
} catch (err) { ... }
try {
  await reactionTracker.load();
} catch (err) { api.logger.warn(...); }
// Cooldown restoration only if initialized
if (initialized) { ... }
```

---

## Group 5: Data Persistence Robustness

**Issues:** #8 (JSONL parse resilience), #17 (EventLog rotation race), #18 (config save race), #24 (missing mkdir)

### Changes

**`src/reactions.ts`** — Per-line try-catch in load to skip corrupt lines instead of losing all data:
```typescript
this.reactions = content.trim().split("\n").filter(Boolean).flatMap((line) => {
  try { return [JSON.parse(line) as ReactionEntry]; }
  catch { return []; }
});
```
Add `await fs.mkdir(path.dirname(this.filePath), { recursive: true });` before writeFile in save().

**`src/events.ts`** — Same per-line try-catch pattern in `readAll()`. For rotation race: the rotate method should write to a temp file then rename (atomic on POSIX):
```typescript
const tmpPath = this.filePath + ".tmp";
await fs.writeFile(tmpPath, kept.map(l => JSON.stringify(l)).join("\n") + "\n");
await fs.rename(tmpPath, this.filePath);
```

**`src/learner.ts`** — Add mkdir before writeFile in `saveTriageProfile()`.

**`src/index.ts`** — For config save race: the simplest fix is to make the config RPC handler enqueue its save through the event queue, or accept the race since config changes are rare (seconds apart at minimum). Recommended: accept the race — config changes are user-initiated and infrequent. Add a comment documenting the known race.

---

## Group 6: Timezone Consistency

**Issues:** #13 (daily counter reset at UTC midnight)

### Changes

**`src/context.ts`** — Change daily boundary detection from UTC-based to local-date-based:
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

This makes the budget reset at local midnight, consistent with the local-time `analysisHour`.

---

## Group 7: Device Config Application

**Issues:** #11 (device config stored but never applied)

### Changes

**`src/pipeline.ts`** — At the start of processEvent (after smartMode check), read device config and compute effective budget:
```typescript
const deviceConfig = context.getDeviceConfig();
const effectiveBudget = deviceConfig.pushBudgetPerDay ?? config.pushBudgetPerDay;
```

Pass `effectiveBudget` to `rules.evaluate()` instead of using the static budget. This requires either:
- Adding a `budget` parameter to `rules.evaluate()` (preferred — keeps RulesEngine stateless for budget)
- Or updating the RulesEngine's budget dynamically

**`src/filter.ts`** — Add optional `budgetOverride` parameter to `evaluate()`:
```typescript
evaluate(event: DeviceEvent, context: DeviceContext, budgetOverride?: number): FilterDecision {
  // ...
  const budget = budgetOverride ?? this.pushBudget;
  if (context.meta.pushesToday >= budget) { ... }
}
```

**`src/triggers.ts`** — Check device config `proactiveEnabled` in `checkAll()`:
```typescript
const deviceConfig = this.context.getDeviceConfig();
if (deviceConfig.proactiveEnabled === false) return;
```

This runs AFTER the smartMode check (which is already there), so both conditions must be true for triggers to fire.
