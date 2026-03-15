# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is an AI orchestrator platform that manages multi-agent workflows. It dispatches tasks to specialized sub-agents (research, analyze, write, code, file) and coordinates their execution. The platform provides a Fastify-based API server with streaming responses, credit-based billing, and sandbox environments for code execution.

## Common Commands

```bash
pnpm dev          # Start the API server (packages/api-server)
pnpm build        # TypeScript type-check only (no emit)
pnpm test         # Run vitest tests
pnpm lint         # Run tsc --noEmit for type checking
pnpm seed         # Create dev user + API key (sk-dev-...)
pnpm orchestrate  # Run CLI orchestrator
```

### Testing

- Integration tests expect a running server: `pnpm dev & sleep 2 && pnpm seed && pnpm test`
- Set `SKIP_LLM_TESTS=1` to skip tests requiring real LLM API calls
- Tests create temporary users/keys via direct DB access
- Test timeout is 30 seconds

## Architecture

### Package Structure (pnpm workspace)

| Package | Purpose |
|---------|---------|
| `@orchestrator/shared` | Types, schemas (Zod), database (SQLite/better-sqlite3), logger (pino), errors |
| `@orchestrator/model-router` | Model registry, request routing, adapters for OpenAI/Anthropic/Google/LiteLLM, tool implementations |
| `@orchestrator/orchestrator` | Workflow engine, sub-agent dispatch, task management via todo lists |
| `@orchestrator/billing` | Credit ledger (append-only), usage tracking |
| `@orchestrator/sandbox` | Workspace management, terminal sessions, code execution |
| `@orchestrator/api-server` | Fastify HTTP server with auth, rate limiting, SSE for workflow events |
| `@orchestrator/cli` | Command-line tools |

### Key Data Flow

1. **Workflow Creation**: `POST /v1/workflows` → `planWorkflow()` → LLM generates task list → `executeWorkflow()` runs orchestrator loop
2. **Model Routing**: `routeRequest()` resolves model → looks up provider → adapter creates response (with fallback chain)
3. **Sub-agent Dispatch**: Orchestrator selects agent type → `dispatchToAgent()` applies config (model, tools, system prompt) → routes to model

### Database (SQLite)

- Path: `./data/orchestrator.db` (configurable via `DATABASE_PATH`)
- WAL mode enabled for concurrent reads
- Migrations run on startup via `runMigrations()`
- Key tables: `users`, `api_keys`, `workflows`, `tasks`, `workflow_steps`, `credit_transactions`, `sandbox_sessions`

### Orchestrator Loop

The engine (`packages/orchestrator/src/engine.ts`) runs a max of 25 iterations:
1. LLM decides actions: `dispatch`, `add_task`, `skip`, `complete`, `delegate_write`
2. Tasks dispatched to specialized agents (research/analyze/write/code/file)
3. Each agent has: preferred model, allowed tools, system prompt
4. Todo list tracks dependencies and ready tasks

### Model Configuration

- Models configured in `packages/model-router/src/model_config.json`
- Format: `provider/model` (e.g., `litellm/gemini-3-flash-preview`)
- Default orchestrator model and allowed models defined in config
- Fallback chains configured per model in registry

### API Authentication

- API keys: `sk-...` format, SHA-256 hashed in DB
- Auth middleware extracts `request.user` for routes
- Rate limiting per user, credit checks on mutating endpoints

### Environment Variables

Required for LLM adapters:
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `GOOGLE_API_KEY`
- `LITELLM_BASE_URL` (optional, for LiteLLM proxy)

Other:
- `DATABASE_PATH` - defaults to `./data/orchestrator.db`
- `PORT` - defaults to 8080
- `TAVILY_API_KEY` - for web search tool

## Important Patterns

### Adding a New Tool

1. Define in `packages/model-router/src/tools/`
2. Export from `packages/model-router/src/index.ts`
3. Add to tool schemas in `packages/shared/src/schemas.ts`
4. Implement in adapter if needed (e.g., Anthropic tool format)

### Adding a New Agent Type

1. Add to `AgentTypeSchema` in `packages/shared/src/schemas.ts`
2. Add config to `AGENT_CONFIGS` in `packages/orchestrator/src/agents.ts`
3. Update `dispatchToAgent` if special handling needed

### Error Handling

- Use typed errors from `@orchestrator/shared`: `AppError`, `ModelError`, `WorkflowError`, `InvalidRequestError`, etc.
- Fastify error handler catches `AppError` instances and formats JSON response

### Streaming

- SSE for workflow events via `getWorkflowEmitter()`
- Model streaming via `routeStreamingRequest()` yields `StreamChunk` objects