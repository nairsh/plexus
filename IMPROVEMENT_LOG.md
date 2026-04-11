# Improvement Log

This file tracks landed improvements and the current refactor and hardening queue for `orchestrator-platform`.

Update it as slices land so the repository keeps an in-tree record of what improved and what is still queued.

## Completed improvements

### API contract alignment

- Registered templates routes in `server.ts` — `/v1/templates*` endpoints were fully implemented in `routes/templates.ts` but never mounted, returning 404. Now live and auth-enforced consistently with all other `/v1/` routes.
- Replaced hardcoded `allowed_agent_types` enum in `routes/teams.ts` (`['research','analyze','write','code','file']`) with the shared `AgentTypeSchema` from `@orchestrator/shared`, which includes `deep_research`. Teams can now accept `deep_research` in `allowed_agent_types` settings.
- Added OpenAPI documentation (`openapi.yaml`) for templates endpoints (`/v1/templates`, `/v1/templates/{id}`, `/v1/templates/{id}/use`) and teams endpoints (`/v1/teams`, `/v1/teams/{id}`), plus `WorkflowTemplate`, `Team`, `TeamSettings`, and `AgentType` component schemas.
- Added 11 focused contract tests (`tests/api-templates-teams-contract.test.ts`) covering route reachability, auth consistency, agent-type acceptance/rejection, and schema alignment.
- Fixed `DELETE /v1/workflows/:id` to cancel-only (preserves workflow row, tasks, and trace history). Previously this endpoint cancelled running workflows and then unconditionally deleted all data — a contract/data-loss bug. Cancelled workflows now remain fetchable, listable, traceable, and retryable.
- Added `POST /v1/workflows/:id/cancel` as the canonical cancel endpoint. `DELETE` is retained as a backward-compatible alias with identical cancel-only behavior.
- Added `workflow_cancelled` event type distinct from `workflow_failed`. Cancellation now emits `workflow_cancelled` with `{ reason }` data instead of masquerading as a failure event. SSE stream, CLI, and menubar all handle the new event type. `workflow_failed` continues to be emitted only for actual failures.
- Made `cancelWorkflow()` idempotent: cancelling an already-cancelled workflow is a no-op. Cancelling a completed workflow throws an explicit error.
- Added 8 focused cancel-semantics tests (`tests/workflow-cancel.test.ts`) covering row preservation, task-state correctness, fetchability, listability, idempotency, user isolation, event type, and transactional atomicity.

### Runtime / orchestrator reliability

- Added work item graph validation (`validateWorkItemGraph`) that detects duplicate task IDs, self-dependencies, dangling dependency references, and dependency cycles before execution dispatch.
- Cycle detection uses Kahn's algorithm (BFS topological sort) — O(V+E), applied after each plan mutation batch in the orchestrator loop; cycles immediately fail the workflow with an actionable diagnostic.
- Self-dependencies are rejected at task creation time in both the `write_todo` tool handler (returns error result for LLM self-correction) and in `createWorkItem` (hard invariant guard via `InvalidRequestError`).
- Dangling dependencies are explicitly detected at `spawn_subagent` dispatch — previously silently treated as "blocked", now returned as a distinct `dangling_dependency` error with a corrective message.
- Enhanced `getReadyWorkItems` to validate graph structure (cycles, self-deps, duplicates) and throw on hard errors instead of silently returning an empty set.
- Added centralized output verification (`outputVerifier.ts`) that rejects empty, refusal-only, and placeholder/filler outputs before they can become durable success records:
  - `runner.ts` (`runSubagentWithRetry`): verifies subagent output before marking work item as completed; invalid output is thrown as a retryable error with a traceable reason.
  - `toolExecutor.ts` (`answer_directly`, `complete_workflow`): validates final output before emitting `workflow_output`; invalid output returns `status: 'error'` with the verification reason.
  - `loop.ts` (`ensureWorkflowCanComplete`): validates candidate output at the top of the guard; invalid output pushes a corrective message and blocks completion.
  - Heuristics are length-gated (refusals ≤ 500 chars, placeholders ≤ 200 chars) to avoid false positives on longer content. 71 focused tests in `output-verification.test.ts`.

### Security / platform hardening

- Hardened provider-key handling with `v1:`-prefixed encryption, safer decrypt behavior, and migration coverage for historical rows.
- Added migration logic for legacy provider-key rows, including edge-case handling for rotated keys and empty-string rows.
- Added outbound webhook signing with delivery metadata and schema/OpenAPI/docs alignment for `webhook_secret`.
- Enforced `callback_url` requirement when `webhook_secret` is supplied: Zod schema cross-field refinement, TypeScript interface, OpenAPI `dependentRequired`, and regression tests.

### Knowledge / memory

- Removed redundant embedding-provider resolution in knowledge retrieval and ingest paths.
- Removed the `embedChunk` escape hatch so future callers cannot reintroduce per-chunk provider re-resolution.
- Added `MIN_VECTOR_SIMILARITY = 0.4` to knowledge retrieval so low-relevance vector matches are filtered out.
- Unified knowledge keyword extraction with the shared `extractKeywords` helper instead of maintaining divergent local behavior.
- Added the missing `knowledge_chunks(user_id, embedding_model)` index.
- Changed memory recall so empty-keyword queries return `[]` instead of unrelated recent memories.
- Changed the `remember` tool so omitted or blank keys default to `deriveMemoryKey(category, content)`, improving deduplication.
- Added embedding-backed semantic memory recall: `saveMemory` stores a pre-computed embedding vector; `recallMemory` performs cosine-similarity search (≥ `MIN_MEMORY_SIMILARITY = 0.4`) when a query embedding is supplied and falls back to keyword search otherwise.  Moved `cosineSimilarity` to the shared `vector.ts` module so both memory and knowledge reuse the same implementation.  `remember`/`recall` tools generate embeddings automatically when an embedding provider is configured.

### Sandbox / tool safety

- Restricted local model-router child-process environments with a shared safe env allowlist instead of inheriting full host secrets.
- Hardened lint subprocesses to use the same safe env strategy.
- Changed `file_edit` to reject ambiguous multi-match replacements instead of silently replacing every occurrence.
- Replaced weak model-router local workspace path checks with sandbox-grade `validatePath()` resolution.
- Hardened `workspaces.ts` path-segment handling so empty and dots-only identifiers are rejected.
- Added root-containment checks in workspace-path derivation to prevent path collapse or escape before destructive workspace operations.
- Hardened sandbox execution with symlink-safe script writes, bounded stdout/stderr capture, reliable status reset on failure, and process-group-aware timeout cleanup.
- Hardened git sandboxing by persisting the original branch, surfacing critical git failures explicitly, and making rollback restore the original checkout without hard-resetting the user branch.
- Hardened `commitGitSandbox` to use strict git execution for `add` and `commit`, verify HEAD advancement after commit, and leave the snapshot in active status on any failure (hook rejection, staging error, stale HEAD). Return type now carries an explicit `error` field on failure.
- Hardened Open Terminal handling by encrypting persisted API keys, adding container hardening flags, returning truthful execution metadata, and cleaning up orphaned containers on startup failure.

## Active tasks

### In progress

- `knowledge-capability-wave2` — continue improving knowledge and memory quality; semantic memory recall landed.
- `sandbox-safety-wave2` — continue hardening the sandbox and tooling layer.

### Pending next tasks

- `api-cancel-endpoint` — ✅ landed: cancel-only semantics, `POST /cancel` endpoint, `workflow_cancelled` event, idempotent cancel, history preservation.
- `api-templates-and-teams-fix` — ✅ landed: registered templates routes and aligned teams enum with `deep_research`.
- `runtime-plan-validation` — ✅ landed: graph validation for work item dependencies (duplicate IDs, self-deps, dangling refs, cycles).
- `runtime-output-verification` — reject empty or refusal-style subagent output before marking work complete.
- `runtime-state-persistence` — persist workflow conversation state for pause/resume and crash recovery.
- `workflow-dogfooding-wave2` — run real workflows, deeply evaluate behavior, and iterate on gaps.

## Notes

- This log is intentionally high signal: it tracks landed improvements and the actual queued work, not every transient investigation step.
- As new slices land, move them from the active or pending sections into the completed section with a concise explanation of what changed.
