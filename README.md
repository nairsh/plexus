# Orchestrator Platform

Multi-Model AI Agent Orchestration Platform — an open-source API layer that orchestrates multiple frontier AI models (OpenAI, Anthropic, Google) with web search, isolated code execution, and DAG-based workflow automation.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   API Server (Fastify)               │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │ Agent API │  │ Sandbox  │  │   Orchestrator    │  │
│  │   /v1/    │  │  API     │  │     /v1/          │  │
│  │ responses │  │  /v1/    │  │   workflows       │  │
│  └─────┬─────┘  └────┬─────┘  └────────┬──────────┘  │
│        │             │                  │             │
│  ┌─────┴─────┐  ┌────┴─────┐  ┌────────┴──────────┐  │
│  │  Model    │  │ Sandbox  │  │   Orchestrator    │  │
│  │  Router   │  │ Manager  │  │   Engine (DAG)    │  │
│  └─────┬─────┘  └────┬─────┘  └───────────────────┘  │
│        │             │                                │
│  ┌─────┴─────────────┴─────┐                          │
│  │    Shared (DB, Auth,    │                          │
│  │   Types, Schemas, Log)  │                          │
│  └─────────────────────────┘                          │
└─────────────────────────────────────────────────────┘
```

**Three core systems:**
1. **Agent API** — Unified multi-provider LLM gateway with web search, URL fetch, and tool calling
2. **Sandbox API** — Isolated code execution (Python, JavaScript, SQL) via `child_process.spawn`
3. **Orchestrator API** — Decomposes objectives into DAGs, dispatches sub-agents in parallel, and persists full workflow traces in SQLite

Additional runtime layers:
- **Workflow Trace Store** — SQLite workflow and step-level logs for replay, audit, and debugging
- **Workspace Store** — persisted per-chat filesystem snapshots under `workspace/<chat_id>/files`
- **Model Config** — runtime orchestrator/sub-agent/tool separation via `packages/model-router/src/model_config.json`

## Quick Start

```bash
# Clone and install
git clone <repo-url> orchestrator-platform
cd orchestrator-platform
pnpm install

# Configure environment
cp .env.example .env
# Edit .env with your provider keys + Clerk settings

# Start the server (runs migrations, seeds models automatically)
pnpm dev

# Seed model registry + dev user record
pnpm seed
```

The API is Clerk-only for auth. Send a Clerk JWT as `Authorization: Bearer <clerk_jwt>`.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_PATH` | No | SQLite database path (default: `./data/orchestrator.db`) |
| `CLERK_SECRET_KEY` | Yes** | Clerk secret key for token verification |
| `CLERK_JWT_KEY` | Optional | Clerk JWT public key for offline verification |
| `CLERK_AUDIENCE` | Optional | Comma-separated accepted JWT audiences |
| `CLERK_AUTHORIZED_PARTIES` | Optional | Comma-separated accepted authorized parties |
| `CLERK_CLOCK_SKEW_MS` | No | Clock skew allowance for JWT verification (default: `5000`) |
| `OPENAI_API_KEY` | Yes* | OpenAI API key |
| `ANTHROPIC_API_KEY` | Yes* | Anthropic API key |
| `GOOGLE_AI_API_KEY` | Yes* | Google AI API key |
| `TAVILY_API_KEY` | No | Tavily API key for `search_web` and `fetch_url` |
| `TAVILY_BASE_URL` | No | Tavily API base URL (default: `https://api.tavily.com`) |
| `TAVILY_RATE_LIMIT_MS` | No | Minimum delay between Tavily calls in ms |
| `PORT` | No | Server port (default: `8080`) |
| `LOG_LEVEL` | No | Log level (default: `info`) |
| `SANDBOX_DEFAULT_TIMEOUT` | No | Default sandbox timeout in seconds (default: `300`) |
| `SANDBOX_MAX_TIMEOUT` | No | Max sandbox timeout in seconds (default: `3600`) |
| `SANDBOX_WORKSPACE_ROOT` | No | Root directory for persisted chat workspaces |
| `OPEN_TERMINAL_IMAGE` | No | Open Terminal Docker image for chat sandboxes |
| `OPEN_TERMINAL_HOST` | No | Host used for Open Terminal port publishing |

\* At least one LLM provider key is required.

\** Either `CLERK_SECRET_KEY` or `CLERK_JWT_KEY` must be set.

## API Endpoints

### System
| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `GET` | `/v1/models` | List available models |
| `GET` | `/v1/presets` | List available presets |

### Agent API
| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/responses` | Create an agent response (LLM call with optional tools) |

### Billing
| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/billing/balance` | Get credit balance |
| `GET` | `/v1/billing/usage` | Get usage details |
| `POST` | `/v1/billing/top-up` | Add credits |
| `GET` | `/v1/billing/transactions` | List credit transactions |

### Sandbox
| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/sandbox/sessions` | Create a sandbox session |
| `GET` | `/v1/sandbox/sessions/:id` | Get session info |
| `POST` | `/v1/sandbox/sessions/:id/execute` | Execute code |
| `GET` | `/v1/sandbox/sessions/:id/files` | List workspace files |
| `GET` | `/v1/sandbox/sessions/:id/file/*path` | Read a file |
| `PUT` | `/v1/sandbox/sessions/:id/file/*path` | Write a file |
| `GET` | `/v1/sandbox/workspaces/:chatId` | Inspect persisted chat workspace |
| `DELETE` | `/v1/sandbox/sessions/:id` | Terminate session |

### Workflows
| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/workflows` | Create and start a workflow |
| `GET` | `/v1/workflows` | List workflows |
| `GET` | `/v1/workflows/:id` | Get workflow details |
| `GET` | `/v1/workflows/:id/trace` | Get full chronological workflow trace |
| `GET` | `/v1/workflows/:id/stream` | SSE stream of workflow events |
| `POST` | `/v1/workflows/:id/approve` | Approve/reject a pending task |
| `DELETE` | `/v1/workflows/:id` | Cancel a workflow |

## Example Usage

### Agent API — Simple completion

```bash
curl -X POST http://localhost:8080/v1/responses \
  -H "Authorization: Bearer <clerk_jwt>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openai/gpt-4o",
    "input": "Explain quantum computing in 3 sentences."
  }'
```

### Agent API — With web search

```bash
curl -X POST http://localhost:8080/v1/responses \
  -H "Authorization: Bearer <clerk_jwt>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openai/gpt-4o",
    "input": "What are the latest developments in AI regulation?",
    "tools": [{"type": "web_search"}]
  }'
```

### Agent API — Using a preset

```bash
curl -X POST http://localhost:8080/v1/responses \
  -H "Authorization: Bearer <clerk_jwt>" \
  -H "Content-Type: application/json" \
  -d '{
    "preset": "pro-search",
    "input": "Compare the market caps of NVIDIA and Apple"
  }'
```

### Agent API — Streaming

```bash
curl -N -X POST http://localhost:8080/v1/responses \
  -H "Authorization: Bearer <clerk_jwt>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openai/gpt-4o-mini",
    "input": "Write a haiku about programming",
    "stream": true
  }'
```

### Sandbox — Execute Python code

```bash
# Create session
SESSION_ID=$(curl -s -X POST http://localhost:8080/v1/sandbox/sessions \
  -H "Authorization: Bearer <clerk_jwt>" \
  -H "Content-Type: application/json" \
  -d '{"language": "python"}' | jq -r '.id')

# Execute code
curl -X POST "http://localhost:8080/v1/sandbox/sessions/$SESSION_ID/execute" \
  -H "Authorization: Bearer <clerk_jwt>" \
  -H "Content-Type: application/json" \
  -d '{
    "code": "import json\nresult = sum(range(100))\nprint(json.dumps({\"sum\": result}))"
  }'

# Terminate when done
curl -X DELETE "http://localhost:8080/v1/sandbox/sessions/$SESSION_ID" \
  -H "Authorization: Bearer <clerk_jwt>"
```

### Workflow — Orchestrate a complex task

```bash
# Start workflow
curl -X POST http://localhost:8080/v1/workflows \
  -H "Authorization: Bearer <clerk_jwt>" \
  -H "Content-Type: application/json" \
  -d '{
    "objective": "Research the top 5 programming languages by popularity in 2025, calculate their year-over-year growth rates, and format the results as a markdown table"
  }'

# Stream progress (SSE)
curl -N "http://localhost:8080/v1/workflows/WORKFLOW_ID/stream" \
  -H "Authorization: Bearer <clerk_jwt>"

# Check status
curl "http://localhost:8080/v1/workflows/WORKFLOW_ID" \
  -H "Authorization: Bearer <clerk_jwt>"
```

## Available Models

| Model ID | Provider | Best For |
|---|---|---|
| `openai/gpt-4o` | OpenAI | Long context, general purpose |
| `openai/gpt-4o-mini` | OpenAI | Fast, cost-effective |
| `anthropic/claude-sonnet-4-20250514` | Anthropic | Code, structured output |
| `google/gemini-2.5-pro` | Google | Research, writing, vision |
| `google/gemini-2.5-flash` | Google | Fast, cost-effective |

## Presets

| Preset | Model | Tools | Use Case |
|---|---|---|---|
| `pro-search` | gpt-4o | web_search, fetch_url | Research with citations |
| `code-assist` | claude-sonnet-4 | code_execution | Code generation and execution |
| `quick-answer` | gpt-4o-mini | web_search | Fast, concise answers |

## Project Structure

```
orchestrator-platform/
├── packages/
│   ├── shared/          # Types, schemas, DB, errors, logger
│   ├── model-router/    # Model registry, provider adapters, tools
│   ├── billing/         # Credit ledger, usage tracking
│   ├── sandbox/         # Isolated code execution
│   ├── orchestrator/    # DAG planner and executor
│   └── api-server/      # Fastify routes, middleware
├── tests/               # Integration tests
├── scripts/             # Seed script
├── openapi.yaml         # OpenAPI 3.1 specification
└── docs/                # Documentation
```

## Testing

```bash
# Start the server
pnpm dev &

# Seed test data
pnpm seed

# Run integration tests (sandbox and billing tests work without LLM keys)
SKIP_LLM_TESTS=1 pnpm test

# Run all tests including LLM calls (requires API keys)
pnpm test
```

## Tech Stack

- **Runtime**: Node.js 20+
- **Language**: TypeScript (strict mode)
- **Framework**: Fastify
- **Database**: SQLite (better-sqlite3)
- **Validation**: Zod
- **Logging**: Pino
- **LLM SDKs**: openai, @anthropic-ai/sdk, @google/generative-ai
- **Testing**: Vitest

No Docker, Redis, or external infrastructure required. Everything runs as a single Node.js process.

## License

MIT
