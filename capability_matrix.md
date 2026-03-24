# Capability Matrix — Orchestrator Platform vs. Perplexity Computer

*Last updated: 2026-03-23*

---

## Section 1: Perplexity Computer — Known Capabilities

### 1.1 Workflow Types

| Capability | Description | Source |
|------------|-------------|--------|
| Deep research reports | Multi-source research with citations, structured reports | Perplexity Pro |
| Multi-step data analysis | Analyze datasets, produce findings | Perplexity Computer |
| File generation | Generate code files, markdown, CSVs, JSON | Perplexity Computer |
| Project scaffolding | Generate complete project directory structures | Perplexity Computer |
| PR / diff creation | Generate diffs, open GitHub PRs | Perplexity Computer |
| Long-running background tasks | Jobs that run for 30+ minutes | Perplexity Computer |
| Multi-agent orchestration | Spawn sub-agents for parallel workstreams | Perplexity Computer |
| Interactive clarification | Ask user for clarification mid-task | Perplexity Computer |
| Scheduled/recurring tasks | Run tasks on a cron schedule | Perplexity Computer |
| Document summarization | Ingest PDFs/docs and summarize | Perplexity Computer |

### 1.2 Skills

| Skill | Description | Available in Ours? |
|-------|-------------|-------------------|
| Web search (real-time) | Search current web with cited sources | ✅ (Tavily/Brave) |
| URL fetching / browser | Fetch full page content | ✅ (fetch_url) |
| Code execution (Python) | Run Python code | ✅ (code_execution) |
| Code execution (JS/Node) | Run JavaScript | ✅ (code_execution) |
| File I/O | Read/write/edit files in workspace | ✅ |
| Bash/shell | Execute shell commands | ✅ |
| Grep/glob | Search codebases | ✅ |
| Knowledge base search | Query stored documents | ✅ (knowledge API) |
| Memory persistence | Remember info across sessions | ✅ (remember/recall) |
| Skills system | Custom pluggable skills | ✅ |
| GitHub integration | Read/write GitHub repos, open PRs | ✅ (connector) |
| Linear integration | Create/manage Linear issues | ✅ (connector) |
| Notion integration | Read/write Notion pages | ✅ (connector) |
| Image generation | Generate images | ❌ Not implemented |
| Data visualization | Generate charts/plots | ❌ Not implemented |
| PDF export | Export content as PDF | ❌ Not implemented |
| Email/calendar access | Gmail, Google Calendar | ❌ Not implemented |
| Spreadsheet manipulation | Excel/Sheets manipulation | ❌ Not implemented |
| Screen/computer use | Interact with desktop GUIs | ❌ Not implemented |
| Voice interaction | Voice input/output | ❌ Not implemented |
| OCR / document parsing | Parse images/scanned docs | ⚠️ Partial (Google OCR model configured) |

### 1.3 UX Patterns

| Pattern | Description | Available in Ours? |
|---------|-------------|-------------------|
| SSE streaming | Real-time token streaming | ✅ |
| Progress indicators | Step-by-step UI feedback | ✅ (step pills, trace events) |
| Intermediate deliverables | Partial outputs during long runs | ✅ (workflow trace events) |
| Approval gates | Human-in-the-loop pause/approve | ✅ (`/approve` endpoint) |
| Workflow cancellation | Cancel in-flight workflows | ✅ (via SSE/cancel) |
| Background execution | Submit and poll later | ✅ (`background=true`) |
| Error recovery/retry | Graceful error handling | ⚠️ Partial (no auto-retry) |
| Source citations | Link to evidence sources | ⚠️ Partial (in text, not structured) |
| Output formatting | Structured markdown/JSON output | ✅ |
| Clarification requests | Agent asks for more info | ⚠️ Not explicitly supported |
| Multi-turn conversations | Continue workflows with follow-up | ⚠️ Partial (chat_id context) |
| Workflow templates | Pre-built workflow starters | ✅ (templates API) |
| Downloadable artifacts | Export files/zips | ⚠️ Partial (workspace files only) |

### 1.4 Robustness Properties

| Property | Target | Ours |
|----------|--------|------|
| Max workflow turns | High | 60 turns (configurable) |
| Long-running support | 30+ minutes | ✅ (background mode) |
| Concurrent subagents | Parallel execution | ✅ (spawn_subagent + await_subagents) |
| Context management | Handle large conversations | ⚠️ Not explicitly truncated/summarized |
| Error isolation | Subagent failure doesn't kill workflow | ✅ |
| Credit/billing guards | Budget enforcement | ✅ (credit precheck middleware) |
| Rate limiting | Per-user rate limits | ✅ (rate-limit middleware) |
| Health monitoring | Agent health tracking | ✅ (agent_health table) |
| Workspace isolation | Per-user/per-chat workspaces | ✅ |
| Auth | Clerk JWT | ✅ |

---

## Section 2: Orchestrator Platform — Current Capabilities Inventory

### 2.1 API Endpoints

| Route | Method | Function |
|-------|--------|---------|
| `/health` | GET | Health check |
| `/v1/responses` | POST | Direct LLM inference + streaming |
| `/v1/workflows` | POST | Create/launch workflow |
| `/v1/workflows/:id` | GET | Get workflow status/details |
| `/v1/workflows/:id/trace` | GET | Get full workflow trace |
| `/v1/workflows/:id/approve` | POST | Approve workflow gate |
| `/v1/workflows` (SSE) | GET | Stream workflow events |
| `/v1/sandbox/sessions` | POST | Create sandbox session |
| `/v1/sandbox/sessions/:id/execute` | POST | Execute code in sandbox |
| `/v1/sandbox/sessions/:id` | GET | Get session info |
| `/v1/sandbox/workspaces/:chatId` | GET | Get workspace files |
| `/v1/billing/balance` | GET | Get credit balance |
| `/v1/billing/top-up` | POST | Add credits |
| `/v1/skills` | GET | List skills |
| `/v1/skills/:id` | GET | Get skill |
| `/v1/skills/import` | POST | Import skill |
| `/v1/memory` | POST | Store memory |
| `/v1/models/preferences` | GET/PUT/DELETE | Model preferences |
| `/v1/connectors/providers` | GET | List connector providers |
| `/v1/connectors` | GET/POST | Manage connectors |
| `/v1/connectors/:id/validate` | POST | Validate connector |
| `/v1/knowledge/documents` | GET/POST | Knowledge base |
| `/v1/knowledge/search` | POST | Search knowledge base |
| `/v1/schedules` | GET/POST/PATCH/DELETE | Scheduled workflows |

### 2.2 Agent Types

| Type | Model | Tools |
|------|-------|-------|
| `research` | Gemini 3 Flash | web_search, fetch_url, run_skill |
| `deep_research` | Gemini 3 Flash | web_search, fetch_url, run_skill |
| `analyze` | Ali Kimi K2.5 | bash, file_read/write/edit, grep, glob, run_skill |
| `write` | Ali Kimi K2.5 | bash, file_read/write/edit, grep, glob, run_skill |
| `code` | Gemini 3 Flash | bash, file_read/write/edit, grep, glob, run_skill |
| `file` | Gemini 3.1 Flash Lite | bash, file_read/write/edit, grep, glob, run_skill |

### 2.3 Model Providers

- LiteLLM (primary router)
- OpenAI
- Anthropic
- Google AI

### 2.4 Known Limitations / Gaps

1. **No image generation** — no DALL-E, Stable Diffusion, or Flux integration
2. **No data visualization** — no chart/plot generation tool
3. **No PDF export** — workflows can't produce downloadable PDFs
4. **No email/calendar integration** — no Gmail, Outlook, Google Calendar connectors
5. **No spreadsheet tool** — no Excel/CSV manipulation tool beyond file_write
6. **No computer/screen use** — no GUI automation
7. **No voice** — text-only
8. **No auto-retry on failure** — failed subagents don't retry automatically
9. **No streaming clarification** — agents can't pause mid-stream to ask user questions
10. **No structured citations** — research output doesn't have structured footnote/citation format
11. **Context window management** — no auto-summarization for very long conversations
12. **No multi-modal input** — no image/file upload processing beyond text
