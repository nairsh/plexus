# Gap Report — Orchestrator Platform vs. Perplexity Computer Parity

*Generated: 2026-03-24*
*Coverage: 88% (141/160 scored points across 33 testable capabilities)*

---

## Executive Summary

After 6 focused bug fixes and 35 test case evaluations, the orchestrator platform reaches 88% capability coverage vs. the Perplexity Computer baseline. The platform excels at core workflow tasks (research, coding, file generation, streaming) but has specific gaps in approval UX, knowledge base (external dependency), and connector configuration.

---

## Category Breakdown

### ✅ Strengths (≥4/5 in all tests)

| Category | Evidence |
|----------|---------|
| Research + Synthesis | Deep research workflows complete with web-sourced, multi-section reports |
| Code Generation | Complete, runnable projects created (FastAPI, Express, TypeScript API) |
| File Generation | Multi-file projects across many languages and frameworks |
| Code Execution | Python execution returns correct output; bash scripts run successfully |
| SSE Streaming | Real-time event delivery (tool_call, tool_result, workflow_completed) |
| Workspace Persistence | Files shared between workflows via chat_id |
| Model Routing | Per-request model override; fallback chain now covers all registered models |
| Memory System | write_memory tool persists preferences; recallMemory retrieves with correct keywords |
| Chained Workflows | 15+ workflows completed in session without resource leaks |
| Multi-Agent Parallelism | spawn_subagent + await_subagents work correctly for parallel tasks |
| Observability | Full trace with tool_call, tool_result, subagent_* events |
| Billing | Credit balance, transactions, enforcement middleware all functional |
| Cancellation | DELETE endpoint cancels running workflows and removes records |
| Error Recovery | Graceful failure on bad inputs; clear error messages |

---

## 🔴 Critical Gaps

### 1. Knowledge Base — Requires Google AI API Key (TC-16)
**Impact:** ❌ Feature blocked. Cannot ingest or search documents.  
**Root cause:** `ingestKnowledgeDocument` calls Google AI embedding API (text-embedding-004). Without `GOOGLE_AI_API_KEY`, all operations fail with 422.  
**Fix options:**  
- Configure `GOOGLE_AI_API_KEY` in production  
- Add alternative embedding backend (local sentence-transformers, or LiteLLM-proxied embeddings)  
- Fall back to BM25/keyword search when no embedding API is available  
**Priority:** HIGH — knowledge base is a core Perplexity parity feature

---

## 🟡 Partial Gaps

### 2. Approval Gate — Auto-Pause Flow Not Implemented (TC-06)
**Impact:** ⚠️ Infrastructure exists but UX loop is incomplete.  
**What works:** `pauseWorkflow`, `resumeWorkflow`, `POST /v1/workflows/:id/approve` endpoints.  
**What's missing:** Orchestrator loop doesn't automatically pause when `human_approval: true` and request approval. The `human_approval` flag triggers bash command approval events but doesn't surface them as paused workflow status.  
**Fix required:** In `orchestrator/loop.ts`, when `human_approval: true`, check for pending approval events and block the loop until `resumeWorkflow` is called.  
**Priority:** MEDIUM — impacts human-in-the-loop workflows

### 3. Skills Invocation — Model Bypasses run_skill (TC-27)
**Impact:** ⚠️ Skills can be created but aren't used in workflows.  
**What works:** Skills CRUD API works; skills stored in DB; run_skill tool is registered.  
**What's missing:** The orchestrator model doesn't know to invoke run_skill when a user-created skill is relevant. Skills are not injected into the orchestrator system prompt as available tools.  
**Fix required:** Inject user skills into the orchestrator's system prompt or tool list at runtime, similar to how `recallMemory` injects memories.  
**Priority:** MEDIUM — skills are a differentiator feature

### 4. Memory Write Tool in Subagents (TC-18 partial)
**Impact:** ⚠️ write_memory is only available to the orchestrator, not subagents.  
**What works:** Orchestrator can call write_memory; memories are recalled for new workflows.  
**What's missing:** Subagent prompts don't include write_memory in their tool set.  
**Fix required:** Add write_memory to the subagent tool executor.  
**Priority:** LOW — orchestrator memory works; subagent use case is secondary

---

## 🔵 External Dependencies (Not Fixable Without Config)

### 5. Connectors — Require OAuth Configuration (TC-15, TC-31)
**Impact:** Cannot test GitHub or Linear connectors without valid OAuth tokens.  
**Status:** API endpoints exist, OAuth state machine implemented.  
**Required:** Configure GitHub App credentials and Linear OAuth app in production.

---

## Recommendations for 90%+ Coverage

To reach 90% coverage from current 88%, implement:

1. **Fix Knowledge Base fallback** (adds ~4 points): Add BM25/keyword fallback in `ingestKnowledgeDocument` for when Google AI is unavailable. This would unblock TC-16 from 1/5 to 3/5.

2. **Fix Skills injection** (adds ~2 points): Inject user skills into orchestrator context at workflow start. This would bring TC-27 from 3/5 to 5/5.

Together: 141 + 4 + 2 = 147/160 = 91.9% ✅

---

## Performance Summary

| Metric | Value |
|--------|-------|
| Server uptime during testing | 3+ hours continuous |
| Workflows completed | 50+ successful |
| Workflows failed (pre-fix) | 6 (all fixed) |
| Test files passing | 19/19 (127 tests, 8 skipped LLM) |
| Average workflow completion time | 30s - 5min |
| Longest workflow attempted | ~7 min (120 turns) |
| Concurrent workflows tested | Up to 4 parallel |

