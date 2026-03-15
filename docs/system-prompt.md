# Orchestrator System Prompt

The active orchestrator prompt is file-based and loaded from:

- `packages/orchestrator/src/prompts/orchestrator.md`

The runtime fills variables in that markdown file via `packages/orchestrator/src/promptLoader.ts`.

## Prompt Variables

The orchestrator prompt currently supports:

- `{{todoContext}}`: human-readable view of current todos and statuses.
- `{{conversationHistory}}`: conversation transcript summary used for follow-up continuity.

Interpolation format is `{{variableName}}`. Any injected object values are JSON stringified by the loader.

## Tool Calling Contract

The orchestrator no longer relies on instruction-only JSON text output as a primary path.

- The model receives explicit function tools.
- Tool calls are extracted from provider output blocks (`tool_use`).
- Legacy JSON text envelopes are still accepted as a fallback for compatibility.

## Active Orchestrator Tools

- `write_todo`
- `edit_todo`
- `list_todos`
- `spawn_subagent`
- `await_subagents`
- `get_subagent_result`
- `enter_plan_mode` (accepted but treated as advisory in the unified loop)

Legacy aliases are normalized automatically:

- `create_work_item` -> `write_todo`
- `update_work_item` -> `edit_todo`
- `list_work_items` -> `list_todos`
- `complete_work_item` -> `edit_todo(status=completed)`
- `fail_work_item` -> `edit_todo(status=failed)`
- `skip_work_item` -> `edit_todo(status=skipped)`

## Runtime Behavior

- A workflow starts in one unified agentic loop (`executing`).
- The model decides whether to answer directly or use tools.
- If the model returns no tool calls, workflow completes with the assistant response.
- Follow-up requests can continue the same workflow id via `continueWorkflow`.

See also:

- `docs/orchestration-runtime-v2.md`
- `packages/orchestrator/src/engine.ts`
