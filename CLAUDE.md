# CLAUDE.md

This file provides repo context for coding agents working in `orchestrator-platform`.

## Rule files and precedence

- Highest precedence: system/developer/user instruction > this file.
- Cursor rules: none found (`.cursorrules` and `.cursor/rules/` absent).
- Copilot rules: none found (`.github/copilot-instructions.md` absent).
- Agent-specific coding guidance also lives in `AGENTS.md`.

## What this repo is

`orchestrator-platform` is a TypeScript monorepo for an agent orchestration backend.

- Fastify API server with `/v1/responses`, `/v1/workflows`, `/v1/sandbox`, `/v1/billing`.
- Multi-provider model router (OpenAI, Anthropic, Google, LiteLLM adapters).
- Turn-based orchestrator loop with todo/work-item lifecycle and subagent dispatch.
- SQLite persistence for users, credits, workflows/tasks, and workflow traces.
- Sandbox sessions with Open Terminal integration and persisted chat workspaces.
- CLI and menubar UIs as separate clients.

Current operational baseline: model IDs and defaults are configured for LiteLLM-style routing in `packages/model-router/src/model_config.json`.

## Workspace map (detailed)

- `packages/shared`
  - `env.ts`: Zod-validated env (`getEnv`, `resetEnvCache`).
  - `db.ts`: SQLite connection + migrations (`runMigrations`).
  - `errors.ts`: typed API errors + `getErrorMessage` helper.
  - `schemas.ts`: request/tool/workflow Zod schemas.
  - `db-schemas.ts`: row validation (`parseRow`, `parseRowOrNull`).
- `packages/model-router`
  - `router.ts`: request routing, preset/model resolution, fallback chain.
  - `registry.ts`: model registry seeding and lookup from SQLite + JSON seeds.
  - `config.ts`: runtime model config read/write.
  - `skills.ts`: local skill loading from backend-local `skills/`.
  - `tools/*`: tavily, file ops, tool defs, executor, approvals, workspace access.
  - `adapters/*`: openai / anthropic / google / litellm adapters.
- `packages/orchestrator`
  - `orchestrator/loop.ts`: core loop (`MAX_TURNS` from workflow state, currently 60).
  - `orchestrator/toolExecutor.ts`: executes orchestrator tool calls.
  - `agents.ts`: per-agent config, model/tool assignment, dispatch.
  - `workItems.ts`: todo/work-item CRUD and dependency logic.
  - `workflow/state.ts`: in-memory workflow state and stream iterator types.
  - `workflow/persistence.ts`: SQLite hydration and status persistence.
  - `workflowTrace.ts` + `orchestrator/tracing.ts`: trace capture and event bridge.
- `packages/api-server`
  - `server.ts`: Fastify app, middleware wiring, global error handler.
  - `routes/responses.ts`: direct model API + streaming + billing/audit side effects.
  - `routes/workflows.ts`: workflow create/continue/list/details/trace/SSE/approve/cancel.
  - `routes/sandbox.ts`: session lifecycle and workspace file endpoints.
  - `routes/billing.ts`: balance/usage/top-up/transactions.
  - `middleware/*`: auth, rate-limit, credit precheck.
- `packages/sandbox`
  - `manager.ts`: create/execute/read/write/list/terminate sessions.
  - `openTerminal.ts`: Open Terminal API integration.
  - `workspaces.ts`: persistent workspace activation/deactivation/snapshots.
- `packages/billing`
  - `ledger.ts`: atomic debit/credit transactions.
  - `usage.ts`: SQL-based aggregation by model/reference type/time window.
- `packages/cli`
  - `src/cli/*`: config/onboarding/models/doctor command surface.
  - `src/orchestrate/*`: interactive and non-interactive orchestration UX.
- `packages/menubar`
  - Tauri + React frontend with its own TS config (`moduleResolution: bundler`).

## Commands

### Install / bootstrap

```bash
pnpm install
pnpm seed
```

### Root scripts

```bash
pnpm dev
pnpm build
pnpm lint
pnpm lint:eslint
pnpm test
pnpm orchestrate
pnpm test-web-search
```

### Package-targeted examples

```bash
pnpm --filter @orchestrator/api-server test
pnpm --filter @orchestrator/orchestrator test
pnpm --filter @orchestrator/model-router test
pnpm --filter @orchestrator/cli test
pnpm --filter @orchestrator/menubar dev
pnpm --filter @orchestrator/menubar build
```

### Single-test runs (important)

```bash
# one test file
pnpm test -- tests/orchestrator-behavior.test.ts

# one test case name
pnpm test -- tests/orchestrator-behavior.test.ts -t "allows direct final output without subagent dispatch"

# package-local test file
pnpm --filter @orchestrator/cli test -- src/ui/chat-app.test.ts
```

### Integration tests

```bash
pnpm dev & sleep 2 && pnpm seed && pnpm test
```

- Integration suite expects server at `http://localhost:8080`.
- Use `SKIP_LLM_TESTS=1 pnpm test` to skip live-provider tests.

## Runtime flow notes

### API server boot

1. `packages/api-server/src/index.ts` imports dotenv and starts server.
2. `startServer()` runs migrations and model registry seed.
3. Middleware chain for `/v1/*`: auth -> rate limit -> credit check for mutating non-billing routes.
4. Global Fastify error handler formats typed errors and validation failures.

### Workflow execution

1. `POST /v1/workflows` calls `planWorkflow()` then background `executeWorkflowToCompletion()` unless `background=true`.
2. `runWorkflow()` loops up to `MAX_TURNS` (currently 60).
3. Orchestrator calls model with manual tool execution and structured tool-call extraction.
4. Todo tools (`write_todo`, `edit_todo`, `spawn_subagent`, `await_subagents`) drive subagent lifecycle.
5. Trace/events persisted/emitted as `tool_call`, `tool_result`, `subagent_*`, completion/failure events.

### Sandbox execution

- Sessions can run local child process execution or Open Terminal-backed execution.
- Path traversal protections are enforced before filesystem operations.
- Child process env is allowlisted to avoid leaking host secrets.

## Data and persistence

- SQLite path defaults to `./data/orchestrator.db` unless `DATABASE_PATH` is set.
- WAL mode and foreign keys enabled.
- Core tables: `users`, `credit_transactions`, `workflows`, `tasks`, `workflow_steps`, `sandbox_sessions`, `sandbox_workspaces`, `audit_log`.
- Migrations are additive/idempotent with guarded `ALTER TABLE` and table recreation only when needed.

## Environment variables (actual names used)

- Core: `PORT` (default `8080`), `LOG_LEVEL`, `NODE_ENV`, `DATABASE_PATH`.
- Providers: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_AI_API_KEY`, `LITELLM_BASE_URL`, `LITELLM_API_KEY`.
- Tools: `TAVILY_API_KEY`, `TAVILY_BASE_URL`, `TAVILY_RATE_LIMIT_MS`, `BRAVE_SEARCH_API_KEY`.
- Skills: backend-local `skills/` directory (test-only override via `CLAUDE_SKILLS_PATH`).
- Sandbox: `SANDBOX_WORKSPACE_ROOT`, `SANDBOX_MAX_TIMEOUT`, `SANDBOX_DEFAULT_TIMEOUT`.
- Open Terminal: `OPEN_TERMINAL_IMAGE`, `OPEN_TERMINAL_HOST`, `OPEN_TERMINAL_START_TIMEOUT_MS`.

## Implementation conventions

- TypeScript strict mode; root packages use NodeNext ESM with explicit `.js` local imports.
- Validate external input with Zod; prefer shared schemas in `@orchestrator/shared`.
- Prefer typed errors (`InvalidRequestError`, `WorkflowError`, `BillingError`, etc.).
- Use shared `logger`; avoid `console.*` outside bootstraps/tests/scripts.
- Prefer `parseRow`/schema-backed row parsing over unchecked DB casts.
- Keep event names/route contracts backward compatible.

## Change playbooks

### Add a new tool

1. Implement tool logic under `packages/model-router/src/tools`.
2. Register in tool defs/registry/executor.
3. Add schema/type coverage in `packages/shared/src/schemas.ts` and `types.ts`.
4. Ensure adapter-specific tool conversion still works.
5. Add/update tests (`tests/tool-registry.test.ts` etc.).

### Add a new agent type

1. Extend shared `AgentType` + schema unions.
2. Add config in `packages/orchestrator/src/agents.ts`.
3. Update orchestrator tool schemas if needed.
4. Add behavior tests in `tests/orchestrator-behavior.test.ts`.

### Add/modify API routes

1. Validate request with Zod `safeParse`.
2. Throw typed shared errors.
3. Keep auth/rate-limit/credit semantics consistent.
4. Add route tests (integration when practical).

## Practical gotchas

- `runWorkflow()` turn cap is 60 (not 25).
- Integration tests can use `TEST_AUTH_BEARER_TOKEN`/`TEST_CLERK_BEARER_TOKEN` for Clerk-first environments.
- Some test-sensitive env access intentionally bypasses cached env (skills/workspace root).
- `tools` column in `tasks` is reused for serialized metadata; preserve compatibility when touching work-item persistence.
