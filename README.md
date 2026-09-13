# plexus

A self-hosted API server that turns a single objective into a DAG of LLM
sub-agent tasks, runs the independent ones in parallel across different model
providers, and records a step-level trace of everything that happened.

It exists because most agent frameworks either hide the execution graph behind a
chat loop, or make you build the graph by hand. Plexus does the middle thing: an
orchestrator model proposes the task graph, the graph is validated before
anything runs, and the runtime persists every step so a workflow can be
replayed, audited, or resumed after a crash.

Status: **experimental**, single-author, pre-1.0. The packages described below
work and are tested. Several route groups exist but are unfinished — see
[Scope](#scope).

## What's actually interesting here

**The plan is data, and it's validated before execution.** The orchestrator
model emits a set of work items with declared dependencies. Before any model
call is billed, `validateWorkItemGraph.ts` rejects cycles, dangling
dependencies, and items that can never become runnable. A malformed plan fails
cheaply instead of half-executing.

**Model selection is per-role, not global.** The orchestrator, the sub-agents,
and tool calls resolve independently through `model-router`, so you can plan
with an expensive reasoning model and fan out to cheap ones. Roles are
configured in `packages/model-router/src/model_config.json` and overridable
per-workflow via `model_overrides`.

**Workflow state is persisted, not just held in memory.** `workflow/state.ts`
holds the live state; `workflow/persistence.ts` snapshots it to SQLite on every
transition. Streaming consumers attach to an emitter backed by the persisted
trace, so a client reconnecting mid-workflow doesn't lose steps.

**Sub-agent output is checked before it's accepted.** `outputVerifier.ts` runs a
verification pass against the work item's acceptance criteria and can send the
item back rather than propagating a bad result to its dependents.

## Architecture

```
                    POST /v1/workflows
                           |
                           v
                 +-------------------+
                 |   orchestrator    |
                 |                   |
   objective --> |  plan -> validate |--> reject malformed plans
                 |         |         |
                 |         v         |
                 |   ready-set loop  |--> trace --+
                 +----+---------+----+            |
                      |         |                 |
              parallel dispatch of                |
              dependency-free items               |
                      |         |                 |
         +------------v--+   +--v-------------+   |
         | model-router  |   |    sandbox     |   |
         | openai | anth |   | spawn + path   |   |
         | google | ...  |   | guards, per-   |   |
         +---------------+   | chat workspace |   |
                             +----------------+   |
                                                  v
                                           SQLite (shared)
                                     workflows, steps, snapshots
```

The loop is a ready-set scheduler, not a topological pre-pass: after each item
completes it recomputes which items have satisfied dependencies and dispatches
that whole set concurrently. A slow item only blocks its own dependents.

Packages (`packages/`):

| Package        | Lines | What it does                                                  |
| -------------- | ----- | ------------------------------------------------------------- |
| `model-router` | ~6.4k | Provider adapters, model registry, tool and web-search plumbing |
| `cli`          | ~5.9k | Terminal client for running and watching workflows              |
| `orchestrator` | ~5.3k | Planning, graph validation, scheduler, tracing, verification    |
| `api-server`   | ~3.4k | Fastify HTTP surface, SSE streaming                             |
| `shared`       | ~2.7k | SQLite access, migrations, shared types and schemas             |
| `sandbox`      | ~1.5k | Command execution, per-chat workspaces, git operations          |

## Requirements

- Node.js >= 20
- pnpm 9
- An API key for at least one provider

`better-sqlite3` is a native dependency. Linux and macOS on Node 20 use a
prebuilt binary. On Windows, or on Node versions without a prebuild, it compiles
from source and needs Python 3 and a C++ toolchain.

## Setup

```sh
pnpm install
export OPENAI_API_KEY=sk-...        # and/or ANTHROPIC_API_KEY, GOOGLE_AI_API_KEY
export TAVILY_API_KEY=tvly-...      # optional, enables the web_search tool
pnpm run seed                       # creates the SQLite db and a dev user
pnpm run dev                        # serves on :3000
```

Other recognised variables: `DATABASE_PATH` (default `./data/app.db`),
`LOG_LEVEL`, `DRY_RUN=1` to plan without issuing model calls, and
`LITELLM_BASE_URL` / `LITELLM_API_KEY` to route everything through a LiteLLM
proxy instead of calling providers directly.

## Running a workflow

```sh
curl -X POST localhost:3000/v1/workflows \
  -H 'content-type: application/json' \
  -d '{
    "objective": "Compare error handling in the three most-starred Rust HTTP clients and write up the tradeoffs.",
    "orchestrator_model": "gpt-5",
    "model_overrides": { "subagent": "claude-sonnet-4-5" }
  }'
```

The response carries a `workflow_id`. Stream progress with:

```sh
curl -N localhost:3000/v1/workflows/<id>/stream
```

```
event: plan
data: {"tasks":[
  {"id":"t1","title":"Identify the three most-starred Rust HTTP clients","deps":[]},
  {"id":"t2","title":"Read reqwest error handling","deps":["t1"]},
  {"id":"t3","title":"Read hyper error handling","deps":["t1"]},
  {"id":"t4","title":"Read ureq error handling","deps":["t1"]},
  {"id":"t5","title":"Write comparison","deps":["t2","t3","t4"]}]}

event: task_started    data: {"id":"t1"}
event: task_completed  data: {"id":"t1","tokens":2841}
event: task_started    data: {"id":"t2"}    <- t2, t3, t4 dispatched together
event: task_started    data: {"id":"t3"}
event: task_started    data: {"id":"t4"}
...
event: workflow_completed  data: {"steps":11,"usd":0.42}
```

Or from the CLI:

```sh
pnpm run orchestrate -- "Compare error handling in the top three Rust HTTP clients"
```

The full trace for a finished workflow is in the `workflow_steps` table, keyed
by workflow id.

## Scope

The packages above are the project. The HTTP surface also exposes `/v1/teams`,
`/v1/billing`, `/v1/connectors`, `/v1/knowledge` and `/v1/schedules`, which came
from an earlier attempt to make this a multi-tenant product. They are partially
implemented, thinly tested, and not something to build on. I've left them in
rather than doing a disruptive removal, but treat them as scaffolding.

## Limitations

- **The sandbox is not a security boundary.** `/v1/sandbox/.../execute` runs
  commands via `child_process.spawn` on the host, with path-traversal guards
  (`session/pathSafety.ts`) and workspace scoping. That stops accidents, not a
  motivated adversary. Don't point it at untrusted input. Real isolation would
  mean a container or VM per session; `openTerminal.ts` shells out to Docker and
  is the nearest starting point.
- Single-node only. Live workflow state lives in an in-process `Map`, so you
  can't run two API servers against one database.
- SQLite with a single writer. Fine for one user, not for concurrent load.
- `MAX_TURNS` caps orchestration depth; deeply recursive objectives get
  truncated rather than failing loudly.
- No auth on the HTTP surface beyond a seeded dev user. Bind it to localhost.
- CI runs Linux only. Windows needs a C++ toolchain for `better-sqlite3`.

## Development

```sh
pnpm run typecheck     # tsc over the whole workspace
pnpm test              # vitest
pnpm run lint:eslint
pnpm run format
```

`docs/orchestration-runtime-v2.md` describes the runtime redesign the current
scheduler came out of. Prompts live in `packages/orchestrator/src/prompts` and
are loaded at runtime by `promptLoader.ts`, so they can be edited without a
rebuild.

## License

MIT
