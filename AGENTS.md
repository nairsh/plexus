# AGENTS.md

Operational guidance for coding agents working in `orchestrator-platform`.

## Scope and precedence

- Use this file as repo-local defaults for implementation behavior.
- Higher-priority instructions (system/developer/user) override this file.
- Prefer minimal, compatible changes unless the task explicitly requests broad refactors.

## Rules discovery

- Cursor rules: none found (`.cursorrules`, `.cursor/rules/` absent).
- Copilot instructions: none found (`.github/copilot-instructions.md` absent).
- Complementary context: `CLAUDE.md` (architecture + runtime mapping).

## Quick repo map

- `packages/shared`: types/schemas/errors/logger/env/db/migrations.
- `packages/model-router`: model routing, adapters, tool registry/executor, skills.
- `packages/orchestrator`: workflow loop, todo/work-item lifecycle, subagent dispatch.
- `packages/api-server`: Fastify routes + auth/rate-limit/credit middleware.
- `packages/sandbox`: session lifecycle, workspace persistence, Open Terminal support.
- `packages/billing`: credit ledger and usage aggregation.
- `packages/cli`: CLI orchestration commands and TUI.
- `packages/menubar`: Tauri + React frontend.

## Build / lint / test commands

## Setup

```bash
pnpm install
pnpm seed
```

## Root scripts

```bash
pnpm dev              # API server entrypoint
pnpm build            # tsc --noEmit
pnpm lint             # tsc --noEmit
pnpm lint:eslint      # eslint packages/*/src/**/*.ts
pnpm test             # vitest
pnpm orchestrate      # CLI orchestrator runner
pnpm test-web-search  # CLI web-search script
```

## Package-scoped examples

```bash
pnpm --filter @orchestrator/api-server test
pnpm --filter @orchestrator/orchestrator test
pnpm --filter @orchestrator/model-router test
pnpm --filter @orchestrator/cli test
pnpm --filter @orchestrator/shared lint
pnpm --filter @orchestrator/menubar dev
pnpm --filter @orchestrator/menubar build
```

## Single-test commands (important)

```bash
# one file
pnpm test -- tests/orchestrator-behavior.test.ts

# one test by name
pnpm test -- tests/orchestrator-behavior.test.ts -t "allows direct final output without subagent dispatch"

# package-local file
pnpm --filter @orchestrator/cli test -- src/ui/chat-app.test.ts
```

## Integration test baseline

```bash
pnpm dev & sleep 2 && pnpm seed && pnpm test
```

- API integration tests target `http://localhost:8080`.
- Use `SKIP_LLM_TESTS=1 pnpm test` to skip tests requiring live providers.

## Style guide for code changes

## Language and module system

- TypeScript strict mode is required.
- Root packages use NodeNext ESM; keep explicit `.js` local import suffixes.
- Menubar package uses bundler module resolution; preserve existing frontend conventions there.

## Formatting

- Prettier config: single quotes, semicolons, width 120, tab width 2, trailing commas (es5).
- Keep diffs compact and avoid gratuitous reformatting unrelated lines.

## Imports

- Order: external modules -> `@orchestrator/*` workspace modules -> relative imports.
- Use `import type` for type-only imports.
- Remove unused imports and keep import lists minimal.

## Types and validation

- Reuse shared interfaces/schemas from `@orchestrator/shared` whenever possible.
- Validate external/request input with Zod (`safeParse` in route boundaries).
- Prefer schema-backed DB parsing (`parseRow`, `parseRowOrNull`) over raw casts.
- Prefer `unknown` + narrowing over `any`; `any` should be exceptional.

## Naming conventions

- `camelCase`: functions/variables.
- `PascalCase`: classes/interfaces/types.
- `UPPER_SNAKE_CASE`: constants.
- Preserve established wire/db names (snake_case fields) for compatibility.

## Error handling and logging

- Throw shared typed errors (`InvalidRequestError`, `WorkflowError`, `SandboxError`, `BillingError`, etc.).
- Let Fastify global error handling format responses.
- Use `getErrorMessage(error)` for unknown error values.
- Use shared `logger`; avoid `console.*` outside bootstrap scripts/tests.
- For non-critical side effects (audit log writes, secondary metering), log and continue.

## Runtime/architecture guardrails

- Orchestrator loop is turn-based (`MAX_TURNS = 60` in workflow state).
- Todo/work-item lifecycle is first-class and persisted through `tasks` table.
- Keep tool execution routed through model-router tool registry/executor path.
- Preserve event and trace behavior (`tool_call`, `tool_result`, `subagent_*`).
- Maintain sandbox path-traversal protections and env allowlist behavior.

## DB and migration expectations

- SQLite is authoritative (`packages/shared/src/db.ts`).
- Keep migrations additive/idempotent and safe for existing data.
- Avoid breaking schema assumptions used by persistence/work-item code.
- Note: `tasks.tools` currently stores serialized task metadata; keep backward compatibility.

## When editing APIs/contracts

- Keep existing endpoint semantics and response shape compatible unless instructed otherwise.
- Ensure auth/rate-limit/credit precheck behavior remains correct for new routes.
- Update shared schemas/types and docs when contracts change.

## Testing expectations after changes

- Run the smallest relevant tests first (single file/test name), then broader suites if needed.
- For orchestrator behavior changes, update/run `tests/orchestrator-behavior.test.ts`.
- For model config/skill loading changes, update/run `tests/model-config.test.ts` and `tests/skills.test.ts`.
- For route changes, add or adjust integration tests in `tests/integration.test.ts`.

## Practical workflow for agents

- Read nearby code paths before editing.
- Make surgical edits and keep names/contracts stable.
- Prefer shared utilities over introducing duplicate helpers.
- If you add a tool/agent/schema, wire all related exports and tests in one change.
