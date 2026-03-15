# Orchestration Runtime V2 (Unified Loop)

## Summary

The orchestrator now uses a single agentic loop instead of rigid PLAN/EXEC phase gates.

Core principle:

1. Call orchestrator model with tools.
2. Execute returned tool calls.
3. Feed results back.
4. If no tool calls are returned, complete workflow with model response.

This removes hard failures for trivial prompts (for example, "Who are you?") where no planning is needed.

## Why this is better

- No mandatory planning for simple requests.
- LLM remains in control of whether to plan, execute, or answer directly.
- Same workflow id can be continued for follow-ups.
- Fewer brittle transitions and less prompt schema coupling.

## State ownership

Todos/work items are persisted in `tasks` and managed in:

- `packages/orchestrator/src/workItems.ts`

Workflow run state lives in memory per active workflow and is persisted to `workflows` status fields.

## Tool protocol

Primary protocol: provider tool-call output (`tool_use`).

Compatibility path: legacy JSON envelopes in response text are parsed and normalized into the new tool contract.

Supported canonical tools:

- `write_todo`
- `edit_todo`
- `list_todos`
- `spawn_subagent`
- `await_subagents`
- `get_subagent_result`

Legacy aliases are normalized in-engine for backward compatibility.

## API compatibility

`/v1/workflows` remains compatible, with an updated response shape that returns task list directly:

- `workflow_id`
- `status`
- `task_count`
- `tasks`

`executeWorkflow` still streams `WorkflowEvent` and now also exposes `done` for non-stream callers.

Continuation endpoint support:

- `POST /v1/workflows/:id/continue`

## CLI UX improvements

- Streaming output remains event-driven.
- Non-stream mode now prints final workflow output (instead of placeholder task dumps).
- Added chat mode:
  - `--chat`
  - `--continue <workflowId>`

## Operational limits

- `MAX_TURNS = 60`

## Validation

Validated with:

- `pnpm lint`
- `pnpm vitest run tests/orchestrator-behavior.test.ts tests/workflow-trace.test.ts`
- CLI smoke run for direct-answer flow (`pnpm orchestrate "Who are you?"`)
