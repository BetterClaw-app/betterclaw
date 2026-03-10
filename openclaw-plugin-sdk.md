# OpenClaw Plugin SDK — What Plugins Can and Cannot Do

## No LLM/Agent Access from Plugins

Plugins **cannot** invoke LLMs or spawn agent sessions. This was discovered through deep investigation of the OpenClaw source code and plugin SDK.

### What we tried
- `runEmbeddedPiAgent` — an internal OpenClaw function used by the core agent. Both betteremail and betterclaw plugins tried to import it via `openclaw/agents/pi-embedded`. This **does not work** because it's not exported in the plugin SDK.

### Why it doesn't work
- The plugin SDK (`openclaw/plugin-sdk`) only exports a limited surface:
  - `OpenClawPluginApi` — the `api` object passed to `register()`
  - `openclaw/plugin-sdk/llm-task` — exists as an export path but provides no agent invocation
- `openclaw/agents/*` is **not an exported path** — the import fails at runtime via Jiti (TypeScript loader)
- `runEmbeddedPiAgent` is internal to OpenClaw's agent system and intentionally not exposed to plugins
- The betterclaw plugin has the **exact same bug** — it also imports `runEmbeddedPiAgent` and has never successfully run its judgment layer

### What plugins CAN do
- `api.registerTool()` — expose tools to the agent (with optional `{ optional: true }` flag)
- `api.registerService()` — run background services (polling loops, etc.)
- `api.registerCommand()` — add `/commands` to the chat UI
- `api.runtime.system.runCommandWithTimeout()` — run shell commands (including `gog`, `openclaw` CLI)
- `api.runtime.state.resolveStateDir()` — get persistent state directory
- `api.pluginConfig` — read plugin config from openclaw.yaml
- `api.logger` — structured logging

### What plugins CANNOT do
- Invoke LLMs or create agent sessions
- Import internal OpenClaw modules outside the plugin SDK exports
- Access `runEmbeddedPiAgent` or any agent runtime internals
- Run embedded "sub-agents" for classification or judgment

### The solution we adopted
Instead of classifying emails in the plugin, we removed the classifier entirely and made the plugin a **pure stateful memory layer**. All emails enter the digest, and the agent triages them during cron-triggered sessions with full context (memory, skills, user preferences). This is actually better because:
1. The agent has full context for triage decisions
2. No separate LLM invocation cost
3. Simpler architecture — the plugin just tracks state
4. Cron job runs in isolated session, only notifies main session when something matters
