# Codebase Refactor Plan

This file persists all analysis findings and the full execution plan across context
compactions. Re-read this file at the start of any new session to resume work.

---

## Code Style Goals (User-Specified)

- No god files — each module has one clear responsibility
- Universal adapters and schemas reused across different sections
- Easy to maintain and add on top of
- Clean separation between: schema definition, format translation, and execution

---

## Status

| Phase | Description | Status |
|-------|-------------|--------|
| 1 | Create shared tool registry | DONE |
| 2 | Refactor all 4 adapters to use tool registry | DONE |
| 3 | Decompose engine.ts into focused modules | DONE |
| 4 | Fix workspaceAccess.ts docker hack | IN PROGRESS |
| 5 | Fix usage.ts in-memory aggregation | DONE |
| 6 | OpenAI SDK modernization | IN PROGRESS |
| 7 | Minor fixes (webSearch passthrough, provider bug, etc.) | DONE |
| 8 | Code quality: error handling, constants, env vars, typing | DONE |

---

## Findings

### CRITICAL-1: Massive Tool Duplication Across All 4 Adapters (~1800 lines)

**Affected files:**
- `packages/model-router/src/adapters/openai.ts` (676 lines)
- `packages/model-router/src/adapters/anthropic.ts` (645 lines)
- `packages/model-router/src/adapters/google.ts` (638 lines)
- `packages/model-router/src/adapters/litellm.ts` (~760 lines)

**What's duplicated:**

Each adapter has its own `buildXTools()` method (~150-200 lines each) defining identical
tool schemas for: `web_search`, `fetch_url`, `code_execution`, `file_read`, `file_write`,
`file_edit`, `bash`, `grep`, `glob`, `run_skill`. The only difference is the output format
(OpenAI/LiteLLM uses `ChatCompletionTool[]`, Anthropic uses `Anthropic.Tool[]`, Google uses
`FunctionDeclaration[]`).

Each adapter also has its own `executeTool()` method (~230 lines each) that is 100%
identical across all four adapters. This calls the same functions from
`packages/model-router/src/tools/fileOperations.ts`, `tavily.ts`, `fetchUrl.ts`, etc.
The same trace callback pattern is copy-pasted for every single tool in every adapter.

**Root cause:** There is no shared tool registry. Tool schema definitions and execution
logic were put directly inside each adapter class.

**The actual implementations already exist in shared modules:**
- `packages/model-router/src/tools/fileOperations.ts` — file_read, file_write, file_edit, bash, grep, glob
- `packages/model-router/src/tools/tavily.ts` — web_search (via searchWeb)
- `packages/model-router/src/tools/fetchUrl.ts` — fetch_url
- `packages/model-router/src/tools/workspaceAccess.ts` — session resolution
- `packages/model-router/src/skills.ts` — run_skill

**The chat_id extraction hack** appears in all 4 adapters' executeTool:
```typescript
const chatId = (request as unknown as { chat_id?: string }).chat_id;
```
This is a type-unsafe workaround because `AgentRequest` does not declare `chat_id`. The
fix is to add `chat_id?: string` to `AgentRequest` in shared types.

---

### CRITICAL-2: engine.ts is a 1540-line God File

**File:** `packages/orchestrator/src/engine.ts`

**Responsibilities crammed into one file:**
1. Workflow state machine (in-memory `Map<string, WorkflowState>`)
2. DB persistence (direct `getDb()` calls throughout)
3. SSE event emission (`EventEmitter` + `emit()` helper)
4. Orchestrator loop (LLM tool call handling + streaming)
5. Sub-agent spawning and lifecycle management (`SubagentRun`, `spawnSubagent()`)
6. Orchestrator tool execution (`write_todo`, `edit_todo`, `list_todos`, `spawn_subagent`,
   `await_subagents`, `get_subagent_result`)
7. Credit tracking (`incrementWorkflowCredits`)
8. Workflow hydration from DB (`hydrateWorkflowState`)
9. Trace step recording (`recordStep`)
10. Prompt building (`buildSystemPrompt`, `buildUserMessage`)

**Orchestrator tools defined inline** at lines 160-258 — these 100-line tool definitions
live right next to the runtime execution logic, making it hard to see what the orchestrator
can do vs. how it does it.

---

### HIGH-3: Outdated OpenAI SDK Usage

**File:** `packages/model-router/src/adapters/openai.ts`

Issues:
- Line 74: `response_format: { type: 'json_object' }` — uses legacy format. The current SDK
  supports `json_schema` with a full JSON Schema object for validated structured output.
- The adapter only uses `chat.completions` — the newer OpenAI Responses API
  (`client.responses.create`) supports stateful conversations, built-in tools, and is the
  recommended path for agentic use cases.
- `parallel_tool_calls: true` is set but never `false` — the parameter is fine but
  deserves to be configurable per-request.

**Package versions** (`packages/model-router/package.json`):
- `openai: ^4.77.0` — latest is 4.91+. Non-breaking minor updates available.
- `@anthropic-ai/sdk: ^0.39.0` — latest is 0.40+.
- `@google/generative-ai: ^0.21.0` — Google has released `@google/genai` v1.0 as the
  replacement package with a new API. The current `@google/generative-ai` is in maintenance
  mode. Migration is a medium-effort refactor of google.ts.

---

### HIGH-4: workspaceAccess.ts — Runtime Docker Shell Hack

**File:** `packages/model-router/src/tools/workspaceAccess.ts`, lines 69-121

The `getOpenTerminalSessionForChat()` function recovers a container's API key at runtime by:
1. Running `docker ps --filter publish=<port>` to find the container name
2. Running `docker inspect --format ...` to read env vars from the container
3. Extracting `OPEN_TERMINAL_API_KEY` with a regex

This is fragile (requires Docker CLI), not portable (breaks in non-Docker deployments),
and a security concern (API key stored in container env readable by any process with Docker
access).

**The comment on line 65 acknowledges the problem:**
```typescript
// Since we don't store the API key in DB for security, we'll need to extract it
// from the running container or use a different approach.
```

**Root cause:** `openTerminal.ts` generates a random API key on container start but
`sandbox/src/manager.ts` only stores the container URL (`open_terminal_url`), not the key.

**Fix:** Store the API key in the DB when the container is started (can be encrypted or
stored in a separate `sandbox_credentials` table if needed), then read it back directly.

---

### MEDIUM-5: usage.ts — In-Memory Model Aggregation

**File:** `packages/billing/src/usage.ts`, lines 52-78

The `getUsageSummary()` function loads ALL transaction rows with metadata into memory
(potentially thousands), parses each JSON metadata blob in JavaScript, and builds the
`by_model` aggregation manually. SQLite supports `json_extract()` which can do this in
one SQL query.

```sql
-- Current approach: loads all rows, parses in JS
SELECT metadata, amount FROM credit_transactions WHERE ...

-- Should be:
SELECT
  json_extract(metadata, '$.model') as model,
  COUNT(*) as requests,
  SUM(ABS(amount)) as cost,
  SUM(COALESCE(json_extract(metadata, '$.total_tokens'), 0)) as tokens
FROM credit_transactions
WHERE user_id = ? AND amount < 0 AND created_at >= ? AND created_at <= ?
  AND metadata IS NOT NULL
  AND json_extract(metadata, '$.model') IS NOT NULL
GROUP BY json_extract(metadata, '$.model')
```

---

### LOW-6: webSearch.ts — Unnecessary Passthrough File

**File:** `packages/model-router/src/tools/webSearch.ts`

This entire 15-line file just re-exports from `tavily.ts` with a type alias:
```typescript
export interface WebSearchResponse extends TavilySearchResponse {}
export async function executeWebSearch(query: string): Promise<WebSearchResponse> {
  return searchWeb(query);
}
```
`WebSearchResponse extends TavilySearchResponse` adds nothing. All 4 adapters import
`executeWebSearch` from here. They should import `searchWeb` from `tavily.ts` directly.
This file can be deleted.

---

### LOW-7: Minor Bugs and Issues

**A) `tavily.ts` line 204 — Wrong provider label for DuckDuckGo results**
```typescript
// searchWebWithPublicFallback() returns DuckDuckGo results but labels them:
return { provider: 'brave', query, results: matches };
// Should be: provider: 'duckduckgo' or a new 'public' value
```

**B) `billing/ledger.ts` line 78 — creditBalance() drops metadata parameter**
`debitCredits()` accepts `metadata?: Record<string, unknown>` (line 25) and stores it.
`creditBalance()` has no `metadata` parameter and always stores `null`. This means
credit top-up transactions have no metadata for auditing.

**C) `fileOperations.ts` lines 384-387 — Fragile manual shell quoting for grep**
```typescript
// Builds shell command string with manual quote escaping:
const command = `grep ${grepArgs.map(arg => "'" + arg.replace(/'/g, "'\"'\"'") + "'").join(' ')}`;
// Should use executeBash's execFile path with array args directly (already supported
// by the local workspace branch — the remote path needs the same treatment)
```

**D) `sandbox/src/manager.ts` line 265 — Spreading all process.env into child**
```typescript
const env: Record<string, string> = { ...process.env as Record<string, string> };
```
This passes all host environment variables (including `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`DATABASE_PATH`, etc.) into sandbox child processes. Should pass a minimal allowlist.

**E) `workspaceAccess.ts` line 13 — Module-level singleton cache**
```typescript
const activeSessions = new Map<string, WorkspaceSession>();
```
This in-process cache does not survive server restarts. After a restart, the DB has rows
for sessions but the cache is empty, causing the docker-inspect fallback on every request
until entries are re-cached.

---

## Refactor Plan

### Phase 1 — Shared Tool Registry

**Goal:** Single source of truth for tool schemas and execution. Adding a new tool
becomes one change in one file.

**New file: `packages/model-router/src/tools/registry.ts`**

```
Exports:
  - CANONICAL_TOOL_DEFS: Map<ToolType, CanonicalToolDef>
    Each entry has: name, description, parameters (JSON Schema), cost, outputBlockType
  
  - executeToolCall(name, args, request, outputBlocks): Promise<ToolCallResult>
    Single shared execution function used by all adapters
    ToolCallResult = { output: string; cost: number; systemMessage?: string }

  - toOpenAITool(def): OpenAI.ChatCompletionTool
  - toAnthropicTool(def): Anthropic.Tool
  - toGoogleDeclaration(def): FunctionDeclaration
  - toLiteLLMTool(def): OpenAI.ChatCompletionTool  (same format as OpenAI)
```

**Fix `AgentRequest` type** in `packages/shared/src/types.ts`:
Add `chat_id?: string` to remove the `as unknown as { chat_id?: string }` hack in all adapters.

**Each adapter becomes:**
```typescript
private buildTools(tools?: Tool[]) {
  return buildToolsForProvider(tools, 'openai'); // or 'anthropic', 'google'
}

private async executeTool(name, argsJson, request, outputBlocks) {
  return executeToolCall(name, JSON.parse(argsJson), request, outputBlocks);
}
```

**Files affected:**
- NEW: `packages/model-router/src/tools/registry.ts`
- MOD: `packages/shared/src/types.ts` (add `chat_id` to AgentRequest)
- MOD: `packages/model-router/src/adapters/openai.ts` (remove buildOpenAITools + executeTool)
- MOD: `packages/model-router/src/adapters/anthropic.ts` (remove buildAnthropicTools + executeTool)
- MOD: `packages/model-router/src/adapters/google.ts` (remove buildGoogleTools + executeTool)
- MOD: `packages/model-router/src/adapters/litellm.ts` (remove buildLiteLLMTools + executeTool)
- DEL: `packages/model-router/src/tools/webSearch.ts` (merge into tavily.ts export)

---

### Phase 2 — Decompose engine.ts

**Goal:** Break 1540-line god file into focused modules. The engine.ts
should be a thin coordinator that delegates to specialized modules.

**New module structure under `packages/orchestrator/src/`:**

```
engine.ts                  ← thin coordinator only (~200 lines)
  imports from all below

workflow/
  state.ts                 ← WorkflowState type + in-memory Map + CRUD
  persistence.ts           ← all getDb() calls: hydrateWorkflow, saveStatus, etc.
  emitter.ts               ← EventEmitter wrapper + emit() helper
  credits.ts               ← incrementWorkflowCredits (delegates to billing)

orchestrator/
  tools.ts                 ← ORCHESTRATOR_TOOLS array (the Tool[] definitions)
  toolExecutor.ts          ← handleOrchestratorTool() switch/dispatch
  loop.ts                  ← the main while(turns) streaming LLM loop
  promptBuilder.ts         ← buildSystemPrompt(), buildUserMessage()

subagents/
  runner.ts                ← SubagentRun type + spawnSubagent() + awaitSubagents()
  lifecycle.ts             ← SubagentRun state transitions, cleanup
```

**Key principle:** `engine.ts` only wires these together and exports the public API
(`executeWorkflow`, `getWorkflowStream`, `cancelWorkflow`, etc.).

---

### Phase 3 — Fix workspaceAccess.ts

**Goal:** Remove the docker-inspect hack. Persist API key when container starts.

**Changes:**
1. `packages/sandbox/src/openTerminal.ts`: `startOpenTerminal()` currently returns
   `OpenTerminalSession` which includes the `apiKey`. This already has the key — it
   just isn't being stored.

2. `packages/sandbox/src/manager.ts` line 113-114: After `startOpenTerminal()`, store
   the key:
   ```typescript
   db.prepare('UPDATE sandbox_sessions SET open_terminal_url = ?, open_terminal_api_key = ? WHERE id = ?')
     .run(openTerminal.baseUrl, openTerminal.apiKey, sessionId);
   ```

3. Add `open_terminal_api_key TEXT` column to `sandbox_sessions` via migration in
   `packages/shared/src/db.ts`.

4. `packages/model-router/src/tools/workspaceAccess.ts`: Replace the docker ps/inspect
   block (lines 69-121) with a direct DB read:
   ```typescript
   const apiKey = row.open_terminal_api_key;
   ```

---

### Phase 4 — Fix usage.ts Aggregation

**File:** `packages/billing/src/usage.ts`

Replace the in-memory loop (lines 52-78) with a single SQL query using `json_extract()`.
SQLite has supported `json_extract` since 3.9.0 (2015). The `better-sqlite3` version in
use fully supports it.

---

### Phase 5 — OpenAI SDK Modernization

**File:** `packages/model-router/src/adapters/openai.ts`

1. Replace `response_format: { type: 'json_object' }` with `response_format: { type: 'json_schema', json_schema: { name: 'response', schema: request.text.format.json_schema, strict: true } }` when a schema is provided.

2. Make `parallel_tool_calls` configurable from `AgentRequest` rather than hardcoded `true`.

3. (Optional/future) Evaluate migrating to Responses API for the agentic loop.

---

### Phase 6 — Minor Fixes

1. **webSearch.ts**: Delete file. Update all 4 adapter imports to use `searchWeb` from
   `./tavily.js` directly. After Phase 1, this is already handled by the registry.

2. **tavily.ts line 204**: Change `provider: 'brave'` to `provider: 'duckduckgo'` in
   `searchWebWithPublicFallback`.

3. **billing/ledger.ts**: Add `metadata?: Record<string, unknown>` parameter to
   `creditBalance()` and store it.

4. **sandbox/src/manager.ts line 265**: Replace `{ ...process.env }` with an explicit
   allowlist of safe environment variables for child processes.

---

## File Map (Before → After)

```
BEFORE                                          AFTER
─────────────────────────────────────────────── ─────────────────────────────────────────────────
adapters/openai.ts (676 lines)               → adapters/openai.ts (~250 lines, no tool logic)
adapters/anthropic.ts (645 lines)            → adapters/anthropic.ts (~250 lines, no tool logic)
adapters/google.ts (638 lines)               → adapters/google.ts (~250 lines, no tool logic)
adapters/litellm.ts (~760 lines)             → adapters/litellm.ts (~250 lines, no tool logic)
tools/webSearch.ts (15 lines passthrough)    → DELETED (import tavily.ts directly)
[no file]                                    → tools/registry.ts (canonical defs + executor)

orchestrator/engine.ts (1540 lines)          → engine.ts (~200 lines, coordinator only)
[no files]                                   → workflow/state.ts
                                             → workflow/persistence.ts
                                             → workflow/emitter.ts
                                             → workflow/credits.ts
                                             → orchestrator/tools.ts
                                             → orchestrator/toolExecutor.ts
                                             → orchestrator/loop.ts
                                             → orchestrator/promptBuilder.ts
                                             → subagents/runner.ts
                                             → subagents/lifecycle.ts

tools/workspaceAccess.ts                     → remove docker hack, read key from DB
shared/src/db.ts                             → add open_terminal_api_key migration
shared/src/types.ts                          → add chat_id to AgentRequest

billing/usage.ts                             → replace JS aggregation with SQL json_extract
billing/ledger.ts                            → add metadata param to creditBalance()
```

---

## How to Resume After Compaction

1. Read this file fully
2. Check the Status table at the top — find the first PENDING phase
3. Read the relevant files listed in that phase's "Files affected" section
4. Implement the changes
5. Run `pnpm lint` after each phase to catch type errors
6. Run `pnpm test` after completing Phase 1 and Phase 2
7. Update the Status table row to DONE when complete
