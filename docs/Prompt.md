Build: Multi-Model AI Agent Orchestration Platform (Perplexity Computer Clone — API Layer)
Context: What You Are Building
You are building the complete API layer for an open-source clone of Perplexity Computer — a cloud-based multi-model AI agent orchestration platform. Perplexity Computer accepts a natural-language objective from a user (e.g., "Research my competitors and build me a comparison dashboard"), autonomously decomposes it into a DAG of subtasks, routes each subtask to the best-fit AI model (from 19+ frontier models across OpenAI, Anthropic, Google, xAI), executes them in parallel inside isolated sandboxes, and delivers finished artifacts.
The key architectural insight is: the orchestration layer is the product, not any single model. Models are specializing — Claude excels at code, Gemini at research/writing, GPT at long-context recall, Grok at speed. The system that intelligently coordinates all of them is what creates value.
You are building three core systems that compose into the full product:
1. Agent API — A unified multi-provider LLM gateway. Any model from any provider, one interface, with built-in web search and tool calling. This is the "call an LLM" primitive that everything else uses.
2. Sandbox API — Isolated code execution environments using child_process.spawn with temp directories. Sub-agents use these to run code, process data, and generate files.
3. Orchestrator API — The brain. Takes a user objective, uses an LLM to plan a DAG of tasks, dispatches sub-agents, monitors progress, handles failures, and assembles final output.
The Agent API and Sandbox API are infrastructure that the Orchestrator consumes internally. They are also exposed as standalone public endpoints.
Tech Stack: Node.js, TypeScript, Fastify, SQLite (via better-sqlite3), Zod for validation, Pino for logging. Official SDKs for OpenAI, Anthropic, and Google AI.
What we are NOT using: Docker, Redis, BullMQ, PostgreSQL, Kubernetes, Terraform, OpenTelemetry, Prometheus. Everything runs as a single node process. We can layer on infrastructure later when we actually need it.
Phase 1: Foundation — Project Setup, Auth, Database, Agent API
What to build
Set up the monorepo, database, authentication, credit tracking, and the Agent API (unified multi-provider LLM gateway with web search).
Monorepo structure

orchestrator-platform/
├── package.json                    # Workspace root (pnpm workspaces)
├── tsconfig.json
├── .env.example
├── packages/
│   ├── shared/                     # Shared types, Zod schemas, DB client, logger
│   │   └── src/
│   │       ├── types.ts            # All TypeScript interfaces (see below)
│   │       ├── schemas.ts          # Zod validation schemas
│   │       ├── db.ts               # SQLite client (better-sqlite3)
│   │       ├── errors.ts           # Error classes matching the error format
│   │       └── logger.ts           # Structured logger (pino)
│   ├── api-server/                 # Fastify HTTP server, route handlers, middleware
│   │   └── src/
│   │       ├── server.ts
│   │       ├── middleware/
│   │       │   ├── auth.ts         # Clerk JWT verification
│   │       │   ├── rateLimit.ts    # In-memory token bucket rate limiter
│   │       │   └── creditCheck.ts  # Pre-flight credit balance check
│   │       └── routes/
│   │           ├── responses.ts    # POST /v1/responses (Agent API)
│   │           ├── workflows.ts    # Orchestrator endpoints (Phase 3)
│   │           ├── sandbox.ts      # Sandbox endpoints (Phase 2)
│   │           └── billing.ts      # Credit/usage endpoints
│   ├── model-router/               # Model selection, provider adapters, fallback chains
│   │   └── src/
│   │       ├── router.ts           # Route task type → model
│   │       ├── registry.ts         # Model registry (JSON config, loaded at boot)
│   │       ├── adapters/
│   │       │   ├── base.ts         # Abstract ModelAdapter interface
│   │       │   ├── openai.ts
│   │       │   ├── anthropic.ts
│   │       │   └── google.ts
│   │       └── tools/
│   │           ├── webSearch.ts    # Web search tool implementation
│   │           └── fetchUrl.ts     # URL fetch tool implementation
│   ├── sandbox/                    # Phase 2
│   ├── orchestrator/               # Phase 3
│   └── billing/                    # Credit ledger, usage tracking
│       └── src/
│           ├── ledger.ts           # Debit/credit operations (atomic SQLite transactions)
│           └── usage.ts            # Usage aggregation queries

Database schema (SQLite)
Create these tables via a simple migration script that runs on startup:

-- Users
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,               -- UUID generated in app code
  email TEXT UNIQUE,
  tier TEXT NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'pro', 'max', 'enterprise')),
  credits_balance REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Credit ledger (append-only for auditability)
CREATE TABLE IF NOT EXISTS credit_transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  amount REAL NOT NULL,              -- negative = debit, positive = credit
  balance_after REAL NOT NULL,
  description TEXT NOT NULL,
  reference_type TEXT,               -- 'workflow', 'response', 'sandbox', 'topup'
  reference_id TEXT,
  metadata TEXT,                     -- JSON string
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_credit_tx_user ON credit_transactions(user_id, created_at);

-- Model registry
CREATE TABLE IF NOT EXISTS model_registry (
  id TEXT PRIMARY KEY,               -- e.g., "openai/gpt-4o"
  provider TEXT NOT NULL,
  display_name TEXT NOT NULL,
  capabilities TEXT NOT NULL,        -- JSON array: ["code", "research", "writing", "vision"]
  cost_per_1m_input REAL NOT NULL,
  cost_per_1m_output REAL NOT NULL,
  max_output_tokens INTEGER,
  context_window INTEGER,
  supports_streaming INTEGER DEFAULT 1,
  supports_tools INTEGER DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deprecated', 'disabled')),
  fallback_models TEXT,              -- JSON array of model IDs
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Workflows (Phase 3, create table now)
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  objective TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','planning','executing','paused','completed','failed','cancelled')),
  plan TEXT,                         -- JSON string (the full DAG)
  config TEXT,                       -- JSON string (model_overrides, tools, human_approval, max_credits, etc.)
  credits_consumed REAL NOT NULL DEFAULT 0,
  error TEXT,                        -- JSON string
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  parent_task_ids TEXT NOT NULL DEFAULT '[]', -- JSON array of task IDs
  task_type TEXT NOT NULL CHECK (task_type IN ('llm_completion','web_search','code_execution','browser_action','file_operation','api_call','human_approval')),
  description TEXT,
  model TEXT,
  tools TEXT,                        -- JSON string
  input_context TEXT,                -- JSON string
  output TEXT,                       -- JSON string
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed','blocked','cancelled')),
  sandbox_id TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  cost TEXT,                         -- JSON string
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_workflow ON tasks(workflow_id, status);

-- Sandbox sessions (Phase 2, create table now)
CREATE TABLE IF NOT EXISTS sandbox_sessions (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  language TEXT NOT NULL CHECK (language IN ('python', 'javascript', 'sql')),
  working_dir TEXT,                  -- path to temp directory
  status TEXT NOT NULL DEFAULT 'creating' CHECK (status IN ('creating','ready','executing','terminated','error')),
  config TEXT,                       -- JSON string (timeout, packages, egress_domains)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  terminated_at TEXT
);

-- Audit log (append-only)
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workflow_id TEXT,
  action TEXT NOT NULL,
  details TEXT,                      -- JSON string
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, created_at);

Core TypeScript interfaces (packages/shared/src/types.ts)

// ── Model Provider Adapter ──
export interface AgentRequest {
  model: string;                          // "openai/gpt-4o"
  input: string | ConversationMessage[];
  instructions?: string;
  tools?: Tool[];
  max_output_tokens?: number;
  temperature?: number;
  stream?: boolean;
  reasoning?: { effort: 'low' | 'medium' | 'high' };
  text?: { format: { type: 'text' | 'json_schema'; json_schema?: object } };
  previous_response_id?: string;
  model_fallback?: string[];
}

export interface AgentResponse {
  id: string;
  model: string;             // actual model used (may differ if fallback triggered)
  status: 'completed' | 'failed' | 'incomplete';
  output: OutputBlock[];     // search_results, fetch_url_results, message blocks
  output_text: string;       // convenience: aggregated text
  usage: UsageInfo;
  tools: Tool[];
  created_at: number;
  completed_at: number;
}

export interface UsageInfo {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost: {
    currency: 'USD';
    input_cost: number;
    output_cost: number;
    tool_calls_cost: number;
    total_cost: number;
  };
}

export interface OutputBlock {
  type: 'search_results' | 'fetch_url_results' | 'message';
  [key: string]: any;
}

export interface Tool {
  type: 'web_search' | 'fetch_url' | 'function' | 'code_execution';
  function?: { name: string; description: string; parameters: object };
}

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | ContentBlock[];
}

export interface ContentBlock {
  type: 'text' | 'image' | 'document';
  text?: string;
  source?: { type: 'base64'; media_type: string; data: string };
}

// ── Model Provider Adapter Interface ──
export interface ModelAdapter {
  readonly provider: string;
  createResponse(request: AgentRequest): Promise<AgentResponse>;
  streamResponse(request: AgentRequest): AsyncIterable<StreamChunk>;
  listModels(): Promise<ModelInfo[]>;
}

export interface StreamChunk {
  type: 'text_delta' | 'tool_use' | 'search_results' | 'done' | 'error';
  text?: string;
  data?: any;
}

export interface ModelInfo {
  id: string;
  provider: string;
  display_name: string;
  capabilities: string[];
  cost_per_1m_input: number;
  cost_per_1m_output: number;
  context_window: number;
  max_output_tokens: number;
}

// ── Sandbox ──
export interface SandboxConfig {
  language: 'python' | 'javascript' | 'sql';
  timeout_seconds?: number;
  packages?: string[];
  files?: Array<{ path: string; content_base64: string }>;
}

export interface SandboxSession {
  id: string;
  status: 'creating' | 'ready' | 'executing' | 'terminated' | 'error';
  language: string;
  created_at: string;
}

export interface ExecutionResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  execution_time_ms: number;
  files_modified: string[];
}

// ── Orchestrator ──
export interface WorkflowConfig {
  objective: string;
  model_overrides?: Record<string, string>;
  tools?: string[];
  max_credits?: number;
  callback_url?: string;
  human_approval?: boolean;
  context_files?: Array<{ filename: string; content_base64: string; media_type: string }>;
  background?: boolean;
}

export interface DAGPlan {
  tasks: DAGTask[];
}

export interface DAGTask {
  task_id: string;
  parent_task_ids: string[];
  task_type: string;
  description: string;
  model?: string;
  tools?: Tool[];
  input_template: string; // may reference outputs of parent tasks via {{task_id}}
}

export interface WorkflowEvent {
  type: 'planning_complete' | 'task_started' | 'task_completed' | 'task_failed' | 'human_approval_required' | 'workflow_completed' | 'workflow_failed' | 'credit_update';
  workflow_id: string;
  task_id?: string;
  data: any;
  timestamp: string;
}

// ── Error format ──
export interface APIError {
  error: {
    type: 'authentication_error' | 'rate_limit_error' | 'invalid_request' | 'model_error' | 'sandbox_error' | 'workflow_error' | 'billing_error' | 'internal_error';
    message: string;
    code: string;
    param?: string;
    retry_after?: number;
  };
}

Model Router configuration (packages/model-router/src/registry.ts)
Load this from a JSON file. It maps task types to model chains and can be updated at runtime without redeployment:

{
  "default_model": "anthropic/claude-sonnet-4-20250514",
  "routing_rules": {
    "code": { "primary": "anthropic/claude-sonnet-4-20250514", "fallbacks": ["openai/gpt-4o", "google/gemini-2.5-pro"] },
    "research": { "primary": "google/gemini-2.5-pro", "fallbacks": ["openai/gpt-4o", "anthropic/claude-sonnet-4-20250514"] },
    "writing": { "primary": "google/gemini-2.5-pro", "fallbacks": ["openai/gpt-4o", "anthropic/claude-sonnet-4-20250514"] },
    "long_context": { "primary": "openai/gpt-4o", "fallbacks": ["google/gemini-2.5-pro"] },
    "fast": { "primary": "openai/gpt-4o-mini", "fallbacks": ["google/gemini-2.5-flash"] },
    "structured_output": { "primary": "anthropic/claude-sonnet-4-20250514", "fallbacks": ["openai/gpt-4o"] }
  }
}

Note: Use models that actually exist in the current API offerings (gpt-4o, claude-sonnet-4-20250514, gemini-2.5-pro, etc.). Use the real model IDs available from each provider's SDK.
Agent API endpoint: POST /v1/responses
This is the workhorse endpoint. Implementation requirements:
1. Parse and validate the request body using Zod.
2. Resolve the model: If model is provided, parse the provider/model_name format. If preset is provided, look up preset config. If model_fallback is provided, store the fallback chain.
3. Create the provider adapter for the resolved model.
4. Handle tools: If web_search tool is present, implement it by calling a search provider (Brave Search API, SerpAPI, or Tavily). If fetch_url tool is present, implement an HTTP fetch + HTML-to-markdown extraction.
5. Call the LLM through the adapter. The adapter translates our unified request format into the provider's native SDK format.
6. Handle tool use loops: If the model returns tool_use in its response, execute the tool, inject the result, and call the model again. Repeat until the model produces a final text response or hits max_tool_calls (default 10).
7. Compute usage: Count tokens, compute cost from the model registry pricing, and return in the response.
8. Debit credits from the user's balance (atomic SQLite transaction).
9. Support streaming: If stream: true, return SSE with text deltas.
Provider adapter implementation pattern:
Each adapter wraps the official SDK:
• OpenAIAdapter.createResponse() calls openai.chat.completions.create() and maps the response to our AgentResponse format.
• AnthropicAdapter.createResponse() calls anthropic.messages.create() and maps accordingly.
• GoogleAdapter.createResponse() calls googleAI.generateContent() and maps accordingly.
The adapter must handle tool calling natively for each provider since they all have slightly different tool formats.
Presets

{
  "pro-search": {
    "model": "openai/gpt-4o",
    "tools": [{ "type": "web_search" }, { "type": "fetch_url" }],
    "max_output_tokens": 8192,
    "instructions": "You are a research assistant. Use web search for current information. Cite sources."
  },
  "code-assist": {
    "model": "anthropic/claude-sonnet-4-20250514",
    "tools": [{ "type": "code_execution" }],
    "max_output_tokens": 16384,
    "instructions": "You are an expert software engineer. Write clean, well-documented code."
  },
  "quick-answer": {
    "model": "openai/gpt-4o-mini",
    "tools": [{ "type": "web_search" }],
    "max_output_tokens": 2048,
    "instructions": "Answer concisely and accurately."
  }
}

Authentication middleware
1. Extract Bearer <token> from the Authorization header.
2. Verify Clerk JWT signature and claims (`exp`, `sub`, audience/authorized parties as configured).
3. Upsert the user by `sub` into local `users` table.
4. Attach the authenticated user to request context.
Rate limiting
In-memory token bucket per user. Store buckets in a Map<string, { tokens: number, lastRefill: number }>. Limits by tier:
• Free: 20 req/min
• Pro: 100 req/min
• Max: 500 req/min
Return 429 with Retry-After header and rate_limit_error in the error body.
Billing endpoints
• GET /v1/billing/balance — returns { credits_balance, tier, usage_this_period }
• GET /v1/billing/usage?start=&end= — returns aggregated usage grouped by model, tool, and workflow
• POST /v1/billing/top-up — body: { amount }, adds credits (just increment the balance for now)
Success criteria for Phase 1
• [ ] pnpm install && pnpm dev starts the server, SQLite DB is created, migrations run automatically
• [ ] Authenticated requests use Clerk JWT bearer tokens
• [ ] POST /v1/responses with model: "openai/gpt-4o" returns a well-formed AgentResponse with correct usage/cost
• [ ] POST /v1/responses with model: "anthropic/claude-sonnet-4-20250514" works through the Anthropic adapter
• [ ] POST /v1/responses with tools: [{ "type": "web_search" }] performs a real web search and the model responds with grounded information
• [ ] POST /v1/responses with model_fallback falls back if the primary model fails
• [ ] POST /v1/responses with preset: "pro-search" resolves the preset correctly
• [ ] POST /v1/responses with stream: true returns SSE text deltas
• [ ] Credits are debited after each request; GET /v1/billing/balance reflects the deduction
• [ ] Rate limiter returns 429 when exceeded
• [ ] All errors follow the standard { error: { type, message, code } } format
• [ ] TypeScript compiles with strict mode, all types pass validation
Phase 2: Sandbox API — Isolated Code Execution
What to build
Code execution environments using child_process.spawn with isolated temp directories. Each sandbox gets its own temp folder, supporting Python, JavaScript, and SQL.
Sandbox Manager (packages/sandbox/src/manager.ts)

interface SandboxManager {
  createSession(userId: string, config: SandboxConfig): Promise<SandboxSession>;
  execute(sessionId: string, code: string, timeout?: number): Promise<ExecutionResult>;
  readFile(sessionId: string, filePath: string): Promise<Buffer>;
  writeFile(sessionId: string, filePath: string, content: Buffer): Promise<void>;
  listFiles(sessionId: string, directory?: string): Promise<string[]>;
  terminate(sessionId: string): Promise<void>;
}

Implementation:
1. createSession: Create a unique temp directory (e.g., os.tmpdir()/sandbox-{uuid}/workspace/). If packages are specified, run pip install --target /workspace/.packages <pkg> or npm install --prefix /workspace <pkg> using child_process.execSync inside the temp dir. If files are provided, write them into the workspace directory. Track sessions in an in-memory Map<string, SessionState> and persist to the sandbox_sessions table. Set status to ready.
2. execute: Write the code to a temp file in the workspace:
    ◦ Python: write to _script.py, run python3 _script.py with PYTHONPATH pointing to .packages/
    ◦ JavaScript: write to _script.js, run node _script.js
    ◦ SQL: run sqlite3 :memory: with the code piped to stdin
Use child_process.spawn with { cwd: workspaceDir, timeout: timeoutMs }. Capture stdout, stderr, exit code. Measure execution time with process.hrtime. Compare filesystem state before/after to detect modified files. Default timeout: 30s, max: 300s.
3. readFile / writeFile / listFiles: Direct filesystem operations scoped to the session's workspace directory. Validate paths to prevent directory traversal (reject any path containing ..).
4. terminate: Kill any running child process for this session. Remove the temp directory recursively (fs.rm(dir, { recursive: true })). Update session status in DB.
Security constraints:
• All file operations are scoped to the session's workspace directory.
• Path traversal prevention: reject paths containing .. or absolute paths.
• Process timeout enforcement via child_process.spawn timeout option.
• Max session duration: 1 hour (configurable). A setInterval reaper checks and terminates expired sessions.
API endpoints
• POST /v1/sandbox/sessions — Create a session. Body: SandboxConfig. Returns SandboxSession.
• POST /v1/sandbox/sessions/:id/execute — Execute code. Body: { code: string, timeout_seconds?: number }. Returns ExecutionResult.
• GET /v1/sandbox/sessions/:id/files/*path — Read a file. Returns file content.
• PUT /v1/sandbox/sessions/:id/files/*path — Write a file.
• GET /v1/sandbox/sessions/:id/files — List files in the workspace.
• DELETE /v1/sandbox/sessions/:id — Terminate session.
Credit metering
Sandbox sessions are metered per-minute of active time. A setInterval (every 60s) checks running sessions and debits credits. Rate: 1 credit per minute.
Integrate sandbox as a tool in Agent API
Add code_execution as a tool type. When a model requests tool use with type: "code_execution", the Agent API:
1. Creates a sandbox session (or reuses one for the current request).
2. Executes the code.
3. Returns stdout/stderr as the tool result.
4. Terminates the session when the response is complete.
Session reaper
A setInterval runs every 5 minutes. It finds sessions where created_at + timeout < now() and status != 'terminated', and terminates them.
Success criteria for Phase 2
• [ ] POST /v1/sandbox/sessions with language: "python" creates a session and returns an ID instantly
• [ ] POST /v1/sandbox/sessions/:id/execute with code: "print(2+2)" returns { stdout: "4\\n", exit_code: 0 }
• [ ] POST /v1/sandbox/sessions/:id/execute with pandas works after creating a session with packages: ["pandas"]
• [ ] File write + file read roundtrip works correctly
• [ ] A 60-second timeout actually kills execution at 60 seconds
• [ ] Session reaper terminates expired sessions
• [ ] POST /v1/responses with tools: [{ "type": "code_execution" }] causes the model to write and execute code
• [ ] Credit metering debits correctly for sandbox time
• [ ] Path traversal attacks are blocked (cannot read/write outside workspace)
Phase 3: Orchestrator — The Brain
What to build
The orchestration engine that accepts a natural-language objective, uses an LLM to decompose it into a DAG of tasks, dispatches sub-agents in parallel, monitors progress, handles failures, and assembles final output.
Orchestrator Engine (packages/orchestrator/src/engine.ts)

interface OrchestratorEngine {
  planWorkflow(userId: string, config: WorkflowConfig): Promise<{ workflowId: string; plan: DAGPlan }>;
  executeWorkflow(workflowId: string): AsyncIterable<WorkflowEvent>;
  pauseWorkflow(workflowId: string): Promise<void>;
  resumeWorkflow(workflowId: string, approvals?: Array<{ task_id: string; approved: boolean; feedback?: string }>): Promise<void>;
  cancelWorkflow(workflowId: string): Promise<void>;
}

Step 1: Planning (planWorkflow)
Use the core reasoning model (Claude or GPT-4o) with a carefully designed system prompt:

You are a workflow planner. Given a user's objective, decompose it into a directed acyclic graph (DAG) of concrete tasks.

Each task must have:
- task_id: a short unique slug (e.g., "research_competitors", "write_report")
- parent_task_ids: array of task_ids this depends on (empty for root tasks)
- task_type: one of "llm_completion", "web_search", "code_execution", "file_operation", "human_approval"
- description: what this task does, in detail
- model: suggested model (use "auto" to let the router decide)
- tools: array of tools needed (e.g., ["web_search"], ["code_execution"])
- input_template: the prompt or instruction for this task. Use {{task_id}} to reference outputs of parent tasks.

Rules:
- Maximize parallelism: tasks without dependencies should have empty parent_task_ids
- Be specific: each task should be a single, well-defined unit of work
- Use web_search for any task requiring current information
- Use code_execution for data processing, calculations, file generation
- Use human_approval before any destructive external action (sending emails, making purchases, deleting data)
- Keep the DAG as shallow as possible (prefer wide parallelism over deep chains)

Respond with ONLY a JSON object: { "tasks": [...] }

Parse the LLM response, validate against the DAGPlan Zod schema, store in the workflows table with status planning → executing.
Step 2: DAG Execution (executeWorkflow)
Build an in-process task scheduler:
1. Topological dispatch: Find all tasks with no unmet dependencies (parent tasks all completed). Execute them in parallel using Promise.all.
2. Task execution: Based on task_type:

    ◦ llm_completion: Call POST /v1/responses internally (the Agent API function directly, no HTTP round-trip needed).
    ◦ web_search: Call the search tool directly.
    ◦ code_execution: Create a sandbox session, execute code, collect output.
    ◦ file_operation: Read/write files in a shared workflow temp directory.
    ◦ human_approval: Pause the workflow, emit human_approval_required event.
3. Output propagation: When a task completes, store its output in the tasks table. Then re-check: are any pending tasks now unblocked? If yes, dispatch them.
4. Input template resolution: Before executing a task, resolve {{task_id}} references in input_template by looking up the parent task's stored output.
5. Error handling: If a task fails, retry up to 2 times (with model fallback on retry). If still failing, mark as failed. The Orchestrator can either fail the workflow or attempt re-planning.
6. Completion: When all tasks are completed, assemble the final output by collecting all leaf-node outputs and optionally running one final LLM call to synthesize them.
Step 3: Workflow State Machine

pending → planning → executing → completed
                  ↓         ↓
                  ↓     → paused → executing
                  ↓
                  → failed
any → cancelled

State transitions must be atomic (SQLite UPDATE with WHERE status = current_status).
Step 4: SSE Streaming (GET /v1/workflows/:id/stream)
Use an in-memory EventEmitter. The workflow execution emits events to a per-workflow emitter. The SSE endpoint listens and forwards events to the client:

event: task_started
data: {"task_id":"research_competitors","description":"Searching for competitor information"}

event: task_completed
data: {"task_id":"research_competitors","output_preview":"Found 5 competitors..."}

event: human_approval_required
data: {"task_id":"send_report_email","description":"Send report to team@company.com","requires":"user_approval"}

event: workflow_completed
data: {"workflow_id":"...","total_credits":4.52,"output":"..."}

API endpoints
• POST /v1/workflows — Create and start a workflow. Body: WorkflowConfig. Returns { workflow_id, status: "planning", created_at, estimated_credits }.
• GET /v1/workflows/:id — Get workflow status, plan (DAG), task statuses, partial outputs, credit consumption.
• GET /v1/workflows/:id/stream — SSE stream of workflow events.
• POST /v1/workflows/:id/approve — Body: { task_id, approved: boolean, feedback?: string }. Resumes a paused workflow.
• DELETE /v1/workflows/:id — Cancel. Kills all running child processes, marks workflow as cancelled.
• GET /v1/workflows — List user's workflows with pagination and status filtering.
Success criteria for Phase 3
• [ ] POST /v1/workflows with a research objective creates a workflow, plans a DAG, and executes to completion
• [ ] The planner generates parallel tasks where possible
• [ ] GET /v1/workflows/:id shows real-time task status transitions
• [ ] GET /v1/workflows/:id/stream delivers SSE events as tasks progress
• [ ] Human approval works: workflow pauses and resumes on approve
• [ ] DELETE /v1/workflows/:id cancels a running workflow
• [ ] Failed tasks retry with model fallback
• [ ] Final assembled output is coherent
• [ ] Credits are debited accurately per task
• [ ] Full audit trail logged
Phase 4: Hardening & Integration Testing
What to build
End-to-end tests, error handling polish, production readiness.
Error handling audit
Walk through every code path and ensure:
• All external calls (LLM SDKs, child_process, SQLite) are wrapped in try/catch
• Timeouts exist on every external call (LLM: 120s, child_process: configurable, DB: 10s)
• Every error maps to the standard APIError format
• Rate limit errors include retry_after
• Model errors trigger fallback before returning failure
• Sandbox errors include stderr for debugging
Integration tests (Vitest)

test("Agent API returns grounded response with web search", async () => {
  const res = await api.post("/v1/responses", {
    model: "openai/gpt-4o",
    input: "What is the current population of Switzerland?",
    tools: [{ type: "web_search" }]
  });
  expect(res.status).toBe("completed");
  expect(res.output_text).toContain("million");
  expect(res.usage.cost.total_cost).toBeGreaterThan(0);
});

test("Sandbox executes Python and returns output", async () => {
  const session = await api.post("/v1/sandbox/sessions", { language: "python" });
  const result = await api.post(`/v1/sandbox/sessions/${session.id}/execute`, {
    code: "import json; print(json.dumps({'result': 42}))"
  });
  expect(result.exit_code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ result: 42 });
});

test("Workflow decomposes objective, executes tasks, delivers result", async () => {
  const workflow = await api.post("/v1/workflows", {
    objective: "Calculate the first 20 Fibonacci numbers and format them as a markdown table"
  });
  let status;
  do {
    status = await api.get(`/v1/workflows/${workflow.workflow_id}`);
    await sleep(2000);
  } while (status.status === "executing" || status.status === "planning");

  expect(status.status).toBe("completed");
  expect(status.credits_consumed).toBeGreaterThan(0);
});

Success criteria for Phase 4
• [ ] All integration tests pass against a running instance (pnpm dev + seed data)
• [ ] Every error path returns the standard error format
• [ ] 10 concurrent sandbox sessions complete without cross-contamination
• [ ] 5 concurrent workflows execute independently
• [ ] Rate limiter throttles correctly under concurrent load
• [ ] OpenAPI spec is generated and valid
• [ ] [README.md](http://readme.md/) documents: setup instructions, env vars, API overview, example curl commands
• [ ] pnpm install && pnpm dev starts everything from scratch
• [ ] All TypeScript compiles with strict: true and no any in public interfaces
Environment Variables

# Database
DATABASE_PATH=./data/orchestrator.db    # SQLite file path

# LLM Provider API Keys
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GOOGLE_AI_API_KEY=...

# Search (pick one)
BRAVE_SEARCH_API_KEY=...
# or SERPAPI_KEY=...
# or TAVILY_API_KEY=...

# Sandbox
SANDBOX_DEFAULT_TIMEOUT=300
SANDBOX_MAX_TIMEOUT=3600

# Server
PORT=3000
NODE_ENV=development
LOG_LEVEL=info

Final Notes
• Start Phase 1 immediately. Each phase builds directly on the previous one. Don't skip ahead.
• Use real provider SDKs. npm install openai @anthropic-ai/sdk @google/generative-ai. Don't mock them.
• The Orchestrator planner prompt is the most critical piece. Invest time in prompt engineering — the quality of the DAG determines the quality of the entire workflow.
• Keep the Agent API OpenAI-compatible where possible. Developers expect that interface.
• Test with real LLM calls. Unit tests can mock, but integration tests must hit real APIs.
• Keep it simple. No Docker, no Redis, no external services beyond the LLM APIs and search. Everything runs in a single Node.js process with SQLite. We scale later.
• To run the project, it should just be pnpm install && pnpm dev. That's it.
Start with Phase 1. After each phase move on to the next WITHOUT askin before proceeding to the next phase. Build incrementally — each phase should result in a working, testable system. You are a workhorse, you need to write as much code and get as muhc done, do not update me, do not ask me, just build based on this PRD. Your sucess criteria is that everythign is built in the end
All Docker, Redis, BullMQ, and PostgreSQL references are replaced with SQLite, in-memory Maps, child_process.spawn, EventEmitter, and setInterval. Same architecture, zero infrastructure dependencies.
