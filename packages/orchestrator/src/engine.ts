import { EventEmitter } from 'node:events';
import {
  getDb,
  logger,
  WorkflowError,
  OrchestratorTaskListSchema,
  OrchestratorDecisionSchema,
} from '@orchestrator/shared';
import type {
  WorkflowConfig,
  WorkflowEvent,
  OrchestratorTask,
  OrchestratorDecision,
  AgentType,
  ToolTraceHooks,
  WorkflowTraceStep,
  TaskMetadata,
  TaskUsageSummary,
  SubagentExecutionResult,
  OrchestratorThinkingData,
} from '@orchestrator/shared';
import {
  routeRequest,
  resolveOrchestratorModel,
} from '@orchestrator/model-router';
import { debitCredits } from '@orchestrator/billing';
import { terminateSession } from '@orchestrator/sandbox';
import { dispatchToAgent } from './agents.js';
import type { AgentExecutionContext } from './agents.js';
import { getWorkflowTrace as readWorkflowTrace, logWorkflowStep } from './workflowTrace.js';
import {
  getTodoList,
  addTodoTask,
  updateTodoTaskStatus,
  skipTodoTask,
  formatTodoListForPrompt,
  getReadyTasks,
  allTasksSettled,
  type TodoList,
  type TodoTask,
} from '@orchestrator/model-router';

// ── Constants ──

const MAX_LOOP_ITERATIONS = 25;
const SIMPLE_WORKFLOW_MAX_TASKS = 6;

// ── In-memory state ──

interface WorkflowState {
  id: string;
  userId: string;
  config: WorkflowConfig;
  orchestratorModel: string;
  status: 'pending' | 'planning' | 'executing' | 'paused' | 'completed' | 'failed' | 'cancelled';
  taskOutputs: Map<string, string>; // Cache for quick access during iteration
  emitter: EventEmitter;
  abortController: AbortController;
  sandboxSessionIds: string[];
  creditsConsumed: number;
}

const workflows = new Map<string, WorkflowState>();

// ── Helpers ──

function emit(state: WorkflowState, event: Omit<WorkflowEvent, 'timestamp'>) {
  const full: WorkflowEvent = {
    ...event,
    timestamp: new Date().toISOString(),
  };
  state.emitter.emit('event', full);
}

function recordStep(
  state: WorkflowState,
  step: Omit<WorkflowTraceStep, 'step_id' | 'workflow_id' | 'timestamp'> & { timestamp?: string }
) {
  return logWorkflowStep({
    workflow_id: state.id,
    timestamp: step.timestamp,
    step_type: step.step_type,
    model_name: step.model_name,
    message_content: step.message_content,
    tool_name: step.tool_name,
    tool_input: step.tool_input,
    tool_output: step.tool_output,
    subagent_id: step.subagent_id,
  });
}

function buildToolTraceHooks(
  state: WorkflowState,
  subagentId: string,
  model?: string
): ToolTraceHooks {
  return {
    model,
    workflow_id: state.id,
    subagent_id: subagentId,
    onToolCall: async (event) => {
      recordStep(state, {
        step_type: subagentId === 'orchestrator' ? 'tool_call' : 'subagent_tool_call',
        model_name: event.model ?? model ?? null,
        message_content: null,
        tool_name: event.name,
        tool_input: event.input,
        tool_output: null,
        subagent_id: event.subagent_id ?? subagentId,
      });
      // Emit event for CLI display
      if (subagentId !== 'orchestrator') {
        emit(state, {
          type: 'subagent_tool_call',
          workflow_id: state.id,
          task_id: subagentId,
          data: {
            tool_name: event.name,
            tool_input: event.input,
          },
        });
      }
    },
    onToolResult: async (event) => {
      recordStep(state, {
        step_type: subagentId === 'orchestrator' ? 'tool_result' : 'subagent_tool_result',
        model_name: event.model ?? model ?? null,
        message_content: null,
        tool_name: event.name,
        tool_input: event.input,
        tool_output: event.output,
        subagent_id: event.subagent_id ?? subagentId,
      });
      // Emit event for CLI display
      if (subagentId !== 'orchestrator') {
        emit(state, {
          type: 'subagent_tool_result',
          workflow_id: state.id,
          task_id: subagentId,
          data: {
            tool_name: event.name,
            tool_output: event.output,
          },
        });
      }
    },
  };
}

function updateWorkflowStatus(
  workflowId: string,
  newStatus: WorkflowState['status'],
  extra?: Record<string, unknown>
) {
  const db = getDb();
  const sets = ["status = ?", "updated_at = datetime('now')"];
  const params: unknown[] = [newStatus];

  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      sets.push(`${key} = ?`);
      params.push(typeof value === 'string' ? value : JSON.stringify(value));
    }
  }

  params.push(workflowId);
  db.prepare(`UPDATE workflows SET ${sets.join(', ')} WHERE id = ?`).run(...params);

  if (newStatus === 'completed' || newStatus === 'failed' || newStatus === 'cancelled') {
    db.prepare(`UPDATE workflows SET ended_at = COALESCE(ended_at, datetime('now')) WHERE id = ?`).run(workflowId);
  }
}

function incrementWorkflowCredits(state: WorkflowState, amount: number) {
  if (!amount || amount <= 0) return;

  state.creditsConsumed += amount;
  const db = getDb();
  db.prepare(
    `UPDATE workflows
     SET credits_consumed = COALESCE(credits_consumed, 0) + ?,
         updated_at = datetime('now')
     WHERE id = ?`
  ).run(amount, state.id);
}

function workflowBudgetExceeded(state: WorkflowState): boolean {
  const budget = state.config.max_credits;
  return typeof budget === 'number' && state.creditsConsumed > budget;
}

/** Strip the workflow-id prefix from task IDs for display */
function shortId(taskId: string, workflowId: string): string {
  return taskId.startsWith(`${workflowId}_`) ? taskId.slice(workflowId.length + 1) : taskId;
}

/** Resolve a short task ID from the orchestrator's response back to the full internal ID */
function resolveTaskId(id: string, workflowId: string, todoList: TodoList): string {
  // Already a full match
  if (todoList.tasks.find(t => t.task_id === id)) return id;
  // Try prefixing
  const prefixed = `${workflowId}_${id}`;
  if (todoList.tasks.find(t => t.task_id === prefixed)) return prefixed;
  return id;
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .filter(token => !new Set(['the', 'a', 'an', 'for', 'to', 'of', 'and', 'or', 'with', 'in', 'on', 'by']).has(token))
    .join(' ');
}

function inferOutputArtifact(agentType: AgentType, taskId: string, description: string): string {
  const normalized = `${taskId} ${description}`.toLowerCase();

  if (agentType === 'write') return 'final_output';
  if (normalized.includes('summary') || normalized.includes('report')) return 'report';
  if (normalized.includes('analysis') || normalized.includes('evaluate')) return 'analysis';
  if (normalized.includes('compare')) return 'comparison';
  if (normalized.includes('scope')) return 'scope_brief';
  if (agentType === 'research') return 'research_brief';

  return `${agentType}_output`;
}

function buildSemanticKey(
  agentType: AgentType,
  description: string,
  dependsOn: string[],
  outputArtifact?: string | null
): string {
  const normalizedDescription = normalizeText(description).split(' ').slice(0, 16).join(' ');
  const normalizedDeps = dependsOn.map(dep => dep.split('_').slice(-3).join('_')).sort().join('|');
  return [agentType, outputArtifact ?? 'artifact', normalizedDescription, normalizedDeps].filter(Boolean).join('::');
}

function buildTaskMetadata(input: {
  origin: 'planned' | 'runtime_generated';
  agentType: AgentType;
  description: string;
  dependsOn: string[];
  outputArtifact?: string | null;
  reasonGenerated?: string | null;
  supersedesTaskId?: string | null;
}): TaskMetadata {
  const outputArtifact = input.outputArtifact ?? inferOutputArtifact(input.agentType, input.description, input.description);
  return {
    origin: input.origin,
    output_artifact: outputArtifact,
    semantic_key: buildSemanticKey(input.agentType, input.description, input.dependsOn, outputArtifact),
    reason_generated: input.reasonGenerated ?? null,
    supersedes_task_id: input.supersedesTaskId ?? null,
  };
}

function areTaskDependenciesSatisfied(task: TodoTask, todoList: TodoList): boolean {
  return task.depends_on.every(depId => {
    const dep = todoList.tasks.find(t => t.task_id === depId);
    return dep?.status === 'completed' || dep?.status === 'skipped';
  });
}

function findSemanticallyEquivalentTask(
  todoList: TodoList,
  agentType: AgentType,
  description: string,
  dependsOn: string[],
  outputArtifact?: string | null
): TodoTask | undefined {
  const semanticKey = buildSemanticKey(agentType, description, dependsOn, outputArtifact ?? inferOutputArtifact(agentType, description, description));
  return todoList.tasks.find(task => task.semantic_key === semanticKey && task.agent_type === agentType && task.status !== 'failed' && task.status !== 'cancelled');
}

function buildObjectivePlanningInput(objective: string): string {
  const lines = [`Objective: ${objective}`];
  const normalized = objective.toLowerCase();

  if (normalized.includes('tanstack') && !/(query|router|table|form|store)/.test(normalized)) {
    lines.push('Scope hint: Treat TanStack as an ecosystem. Explicitly decide which packages are relevant here (likely Query, Router, Table, Form, Store), explain what is included or excluded, and tailor the scope to the user objective.');
  }

  if (/(ecosystem|suite|family|platform)/.test(normalized)) {
    lines.push('Scope hint: The request appears broad. Normalize the scope into concrete subtopics, make inclusions/exclusions explicit, and decompose tasks so each sub-agent investigates a materially distinct question.');
  }

  return lines.join('\n');
}

function buildDirectDispatchDecision(todoList: TodoList): OrchestratorDecision | null {
  const readyTasks = getReadyTasks(todoList);
  if (readyTasks.length === 0) {
    return null;
  }

  const pendingCount = todoList.tasks.filter(task => task.status === 'pending').length;
  const allReadyAreNonWrite = readyTasks.every(task => task.agent_type !== 'write');
  const simpleWorkflow = todoList.tasks.length <= SIMPLE_WORKFLOW_MAX_TASKS;

  if ((simpleWorkflow && allReadyAreNonWrite) || pendingCount === readyTasks.length || readyTasks.length === 1) {
    return {
      thinking: 'Direct dispatch: existing planned tasks are ready, dependencies are unambiguous, and replanning would add unnecessary overhead.',
      actions: [{ type: 'dispatch', task_ids: readyTasks.map(task => task.task_id) }],
    };
  }

  return null;
}

function buildDirectCompletionDecision(todoList: TodoList): OrchestratorDecision | null {
  if (!allTasksSettled(todoList)) {
    return null;
  }

  const completedWriteTask = [...todoList.tasks]
    .reverse()
    .find(task => task.status === 'completed' && task.agent_type === 'write' && task.output);

  if (completedWriteTask?.output) {
    return {
      thinking: 'Workflow wrap-up: the planned final write task already finished, so I can finalize immediately.',
      actions: [{ type: 'complete', output: completedWriteTask.output }],
    };
  }

  return null;
}

function summarizeTaskUsage(result: SubagentExecutionResult): TaskUsageSummary {
  return {
    model: result.model,
    input_tokens: result.usage.input_tokens,
    output_tokens: result.usage.output_tokens,
    total_tokens: result.usage.total_tokens,
  };
}

function buildTaskCompletionPayload(result: SubagentExecutionResult) {
  const output = result.output;
  return {
    output_preview: output.substring(0, 500),
    usage: summarizeTaskUsage(result),
    output_line_count: output.split(/\r?\n/).length,
    output_word_count: output.trim().length === 0 ? 0 : output.trim().split(/\s+/).length,
  };
}

function classifyDecisionMode(thinking: string): OrchestratorThinkingData['mode'] {
  if (thinking.startsWith('Direct dispatch:')) return 'direct_dispatch';
  if (thinking.startsWith('Workflow wrap-up:')) return 'direct_completion';
  if (thinking.startsWith('Fallback:')) return 'fallback';
  return 'llm';
}

// ── Prompt builders ──

function buildPlanningSystemPrompt(): string {
  return `You are an orchestrator that decomposes user objectives into an actionable task list for specialized AI sub-agents.

## Available Sub-Agent Types

- **research**: Searches the web and fetches URLs to gather current information. Use for any task requiring external information.
- **analyze**: Synthesizes and reasons over research findings. No tool access — receives context, produces structured analysis.
- **write**: Produces polished long-form content (reports, summaries, articles). No tool access — receives context, produces final text.
- **code**: Writes and executes code in a sandbox (bash, file tools). Use for computational tasks, data processing, or automation.
- **file**: Performs file system operations (read, write, edit files). Use when workspace artifacts are needed.

## Rules

1. Most objectives start with one or more **research** tasks.
2. **analyze** tasks depend on research tasks that gather data.
3. **write** tasks depend on analysis or research tasks — write comes last.
4. Independent tasks (no shared dependencies) can run in parallel — keep depends_on empty for them.
5. Keep the list focused: **3–8 tasks** for most objectives. The orchestrator can add more dynamically.
6. Use snake_case task IDs that are short and descriptive (e.g., "research_latest_news").
7. Do not over-specify. Trust the sub-agents to handle their domain.
8. Normalize broad scope early. If the user names an ecosystem, suite, or product family, translate it into concrete investigation areas and make the scope explicit in task descriptions.
9. Decompose work into materially distinct investigations. Each research task should answer a different evidence question, not just a different report section.
10. Include "output_artifact" for every task to clarify the intended deliverable. Use concise values like "research_brief", "analysis", "comparison", "scope_brief", or "final_output".

## Response Format

Respond with ONLY valid JSON:

{
  "tasks": [
    {
      "task_id": "research_topic",
      "description": "Search for the latest news about X and summarize key findings",
      "agent_type": "research",
      "depends_on": [],
      "output_artifact": "research_brief"
    },
    {
      "task_id": "analyze_findings",
      "description": "Analyze the research findings and identify key trends and patterns",
      "agent_type": "analyze",
      "depends_on": ["research_topic"],
      "output_artifact": "analysis"
    },
    {
      "task_id": "write_report",
      "description": "Write a comprehensive report based on the analysis",
      "agent_type": "write",
      "depends_on": ["analyze_findings"],
      "output_artifact": "final_output"
    }
  ]
}`;
}

function buildOrchestratorLoopSystemPrompt(todoList: TodoList): string {
  const todoSection = formatTodoListForPrompt(todoList, 1500);
  
  return `You are an intelligent orchestrator directing specialized AI sub-agents to accomplish a user's objective.

${todoSection}

## Available Actions

When you respond, you can take these actions:

- **dispatch**: Send one or more pending tasks (with satisfied dependencies) to their assigned agents.
  Example: { "type": "dispatch", "task_ids": ["research_a", "research_b"] }

- **add_task**: Add a new task to the list if you discover more work is needed.
  Example: { "type": "add_task", "task_id": "follow_up_research", "description": "Research X in more detail", "agent_type": "research", "depends_on": ["research_a"], "reason_generated": "Need missing evidence on mobile constraints", "output_artifact": "research_brief" }

- **skip**: Mark a task as unnecessary if you already have sufficient information.
  Example: { "type": "skip", "task_id": "redundant_task", "reason": "Already covered by previous research" }

- **complete**: You have enough information to produce the final output yourself. Write it fully in the "output" field. Use for concise outputs.
  Example: { "type": "complete", "output": "The answer is..." }

- **delegate_write**: Hand off to the write agent for long-form, structured, or complex outputs.
  Example: { "type": "delegate_write", "prompt": "Write a report covering: [full context]" }

## Rules

1. **Check dependencies**: Only dispatch tasks whose depends_on tasks are all completed or skipped.
2. **Parallelize**: Dispatch multiple independent tasks together in one dispatch action.
3. **Never re-dispatch**: Don't dispatch tasks that are already running, completed, failed, or skipped.
4. **Be adaptive**: If research reveals unexpected complexity, add tasks. If the answer is clear early, skip and complete.
5. **One terminal action**: You can only have one "complete" or "delegate_write" action per response. Include it last when done.
6. **Progress tracking**: The task list above shows current status. Use it to decide next steps.
7. **Prefer planned tasks**: Always dispatch an existing ready task before generating a new semantically equivalent one.
8. **Use runtime mutation sparingly**: Only add a task if no pending or ready task can achieve the same artifact. If you add one, include "reason_generated", "output_artifact", and "supersedes_task_id" when relevant.
9. **Compress simple workflows**: If the remaining path is obvious and already planned, dispatch directly instead of spending another loop on replanning.

## Response Format

Respond with ONLY valid JSON:

{
  "thinking": "1-2 sentences explaining your reasoning based on the current task list.",
  "actions": [
    { "type": "dispatch", "task_ids": ["task_1"] },
    { "type": "complete", "output": "The final answer..." }
  ]
}`;
}

/** Build the context prompt for a specific agent task */
function buildAgentTaskPrompt(state: WorkflowState, task: TodoTask, todoList: TodoList): string {
  const lines: string[] = [];

  lines.push(`## Your Task\n${task.description}`);
  if (task.output_artifact) {
    lines.push('');
    lines.push(`## Expected Deliverable\n${task.output_artifact}`);
  }

  // Include outputs of dependency tasks as context
  if (task.depends_on.length > 0) {
    lines.push('');
    lines.push('## Context From Prior Work');
    for (const depId of task.depends_on) {
      const depTask = todoList.tasks.find(t => t.task_id === depId);
      if (depTask?.output) {
        const preview = depTask.output.length > 2000
          ? depTask.output.substring(0, 2000) + '\n[...truncated...]'
          : depTask.output;
        lines.push(`\n### Output from ${depId}:`);
        lines.push(preview);
      }
    }
  }

  lines.push('');
  lines.push(`## Overall Objective\n${state.config.objective}`);

  if (task.agent_type === 'write') {
    lines.push('');
    lines.push('## Writing Constraints');
    lines.push('- Start with a short scope section that states what was included and excluded.');
    lines.push('- Prefer concise headings and bullets over wide markdown tables.');
    lines.push('- Distinguish strongest confirmed findings from likely inferences.');
    lines.push('- End with a practical recommendation and any important uncertainty.');
  }

  return lines.join('\n');
}

// ── Engine API ──

export async function planWorkflow(
  userId: string,
  config: WorkflowConfig
): Promise<{ workflowId: string; tasks: OrchestratorTask[] }> {
  const workflowId = crypto.randomUUID();
  const plannerModel = resolveOrchestratorModel(
    config.orchestrator_model ?? config.model_overrides?.['planner']
  );

  // Persist workflow
  const db = getDb();
  db.prepare(
    `INSERT INTO workflows (id, user_id, objective, user_prompt, orchestrator_model, status, config, started_at)
     VALUES (?, ?, ?, ?, ?, 'planning', ?, datetime('now'))`
  ).run(workflowId, userId, config.objective, config.objective, plannerModel, JSON.stringify(config));

  const state: WorkflowState = {
    id: workflowId,
    userId,
    config,
    orchestratorModel: plannerModel,
    status: 'planning',
    taskOutputs: new Map(),
    emitter: new EventEmitter(),
    abortController: new AbortController(),
    sandboxSessionIds: [],
    creditsConsumed: 0,
  };
  state.emitter.setMaxListeners(50);
  workflows.set(workflowId, state);

  recordStep(state, {
    step_type: 'orchestrator_message',
    model_name: plannerModel,
    message_content: `Planning: ${config.objective}`,
    tool_name: null,
    tool_input: null,
    tool_output: null,
    subagent_id: 'orchestrator',
  });

  try {
    const response = await routeRequest({
      model: plannerModel,
      input: buildObjectivePlanningInput(config.objective),
      instructions: buildPlanningSystemPrompt(),
      max_output_tokens: 2048,
      temperature: 0.1,
      text: { format: { type: 'json_schema' } },
      trace: buildToolTraceHooks(state, 'orchestrator', plannerModel),
    });

    // Debit planning cost
    if (response.usage.cost.total_cost > 0) {
      try {
        debitCredits(userId, response.usage.cost.total_cost, `Workflow planning: ${workflowId}`, 'workflow', workflowId);
        incrementWorkflowCredits(state, response.usage.cost.total_cost);
      } catch {
        // Non-critical
      }
    }

    recordStep(state, {
      step_type: 'system_event',
      model_name: plannerModel,
      message_content: 'planning_response',
      tool_name: null,
      tool_input: null,
      tool_output: response.output_text,
      subagent_id: 'orchestrator',
    });

    // Parse task list
    let planJson: unknown;
    try {
      let text = response.output_text.trim();
      if (text.startsWith('```')) {
        text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }
      planJson = JSON.parse(text);
    } catch {
      throw new WorkflowError(`Failed to parse planning response as JSON: ${response.output_text.substring(0, 200)}`);
    }

    const parseResult = OrchestratorTaskListSchema.safeParse(planJson);
    if (!parseResult.success) {
      throw new WorkflowError(`Invalid task list from planner: ${parseResult.error.message}`);
    }

    const rawTasks = parseResult.data.tasks;

    // Add tasks to todo list via the tool
    const internalTasks: OrchestratorTask[] = [];
    
    for (const raw of rawTasks) {
      const outputArtifact = raw.output_artifact ?? inferOutputArtifact(raw.agent_type as AgentType, raw.task_id, raw.description);
      const resolvedDependsOn = raw.depends_on.map(d => `${workflowId}_${d}`);
      const task = await addTodoTask(
        workflowId,
        raw.task_id,
        raw.description,
        raw.agent_type as AgentType,
        resolvedDependsOn,
        buildTaskMetadata({
          origin: 'planned',
          agentType: raw.agent_type as AgentType,
          description: raw.description,
          dependsOn: resolvedDependsOn,
          outputArtifact,
        })
      );
      
      internalTasks.push({
        task_id: task.task_id,
        description: task.description,
        agent_type: task.agent_type,
        depends_on: task.depends_on,
        status: task.status,
        origin: task.origin,
        semantic_key: task.semantic_key,
        output_artifact: task.output_artifact,
        reason_generated: task.reason_generated,
        supersedes_task_id: task.supersedes_task_id,
      });
    }

    state.status = 'executing';
    updateWorkflowStatus(workflowId, 'executing', {
      plan: JSON.stringify({
        tasks: internalTasks.map(t => ({
          task_id: t.task_id,
          parent_task_ids: t.depends_on,
          task_type: t.agent_type,
          description: t.description,
          model: null,
          tools: JSON.stringify({
            origin: t.origin ?? null,
            output_artifact: t.output_artifact ?? null,
            semantic_key: t.semantic_key ?? null,
            reason_generated: t.reason_generated ?? null,
            supersedes_task_id: t.supersedes_task_id ?? null,
          }),
          input_template: t.description,
        })),
      }),
    });

    recordStep(state, {
      step_type: 'system_event',
      model_name: plannerModel,
      message_content: 'tasks_initialized',
      tool_name: null,
      tool_input: null,
      tool_output: { task_count: internalTasks.length },
      subagent_id: 'orchestrator',
    });

    // Emit events
    emit(state, {
      type: 'tasks_initialized',
      workflow_id: workflowId,
      data: {
        task_count: internalTasks.length,
        tasks: internalTasks.map(t => ({
            id: t.task_id,
            description: t.description,
            agent_type: t.agent_type,
            depends_on: t.depends_on,
            status: t.status,
            origin: t.origin,
            output_artifact: t.output_artifact,
            reason_generated: t.reason_generated,
            supersedes_task_id: t.supersedes_task_id,
          })),
        },
      });

    // Legacy planning_complete event for backward compat
    emit(state, {
      type: 'planning_complete',
      workflow_id: workflowId,
      data: {
        task_count: internalTasks.length,
        tasks: internalTasks.map(t => ({
          id: t.task_id,
          type: t.agent_type,
          description: t.description,
          depends_on: t.depends_on,
        })),
      },
    });

    logger.info({ workflowId, taskCount: internalTasks.length }, 'Workflow planned');

    return { workflowId, tasks: internalTasks };
  } catch (err) {
    state.status = 'failed';
    updateWorkflowStatus(workflowId, 'failed', { error: (err as Error).message });
    emit(state, { type: 'workflow_failed', workflow_id: workflowId, data: { error: (err as Error).message } });
    throw err;
  }
}

export async function* executeWorkflow(workflowId: string): AsyncIterable<WorkflowEvent> {
  const state = workflows.get(workflowId);
  if (!state) throw new WorkflowError(`Workflow not found: ${workflowId}`);

  const eventQueue: WorkflowEvent[] = [];
  let resolve: (() => void) | null = null;
  let done = false;

  const listener = (event: WorkflowEvent) => {
    eventQueue.push(event);
    if (resolve) {
      resolve();
      resolve = null;
    }
  };

  state.emitter.on('event', listener);

  const executionPromise = runWorkflow(state).finally(() => {
    done = true;
    if (resolve) {
      resolve();
      resolve = null;
    }
  });

  try {
    while (true) {
      if (eventQueue.length > 0) {
        yield eventQueue.shift()!;
      } else if (done) {
        while (eventQueue.length > 0) {
          yield eventQueue.shift()!;
        }
        break;
      } else {
        await new Promise<void>((r) => {
          resolve = r;
        });
      }
    }
  } finally {
    state.emitter.off('event', listener);
    await executionPromise.catch(() => {});
  }
}

async function runWorkflow(state: WorkflowState): Promise<void> {
  let iteration = 0;

  while (state.status === 'executing' && iteration < MAX_LOOP_ITERATIONS) {
    iteration++;

    // Budget check
    if (workflowBudgetExceeded(state)) {
      state.status = 'failed';
      const msg = `Workflow exceeded max_credits budget of ${state.config.max_credits}`;
      updateWorkflowStatus(state.id, 'failed', { error: msg });
      emit(state, {
        type: 'workflow_failed',
        workflow_id: state.id,
        data: { error: msg, credits_consumed: state.creditsConsumed },
      });
      break;
    }

    // Abort check
    if (state.abortController.signal.aborted) {
      state.status = 'cancelled';
      updateWorkflowStatus(state.id, 'cancelled');
      emit(state, { type: 'workflow_failed', workflow_id: state.id, data: { error: 'Workflow cancelled' } });
      return;
    }

    // Fetch current todo list from database (source of truth)
    const todoList = await getTodoList(state.id);

    // Update local cache
    for (const task of todoList.tasks) {
      if (task.output) {
        state.taskOutputs.set(task.task_id, task.output);
      }
    }

    // Build prompt with todo list included
    const systemPrompt = buildOrchestratorLoopSystemPrompt(todoList);

    recordStep(state, {
      step_type: 'orchestrator_message',
      model_name: state.orchestratorModel,
      message_content: `Iteration ${iteration}: evaluating state`,
      tool_name: null,
      tool_input: { iteration, task_count: todoList.tasks.length },
      tool_output: null,
      subagent_id: 'orchestrator',
    });

    let decision: OrchestratorDecision;

    const directCompletionDecision = buildDirectCompletionDecision(todoList);
    if (directCompletionDecision) {
      decision = directCompletionDecision;
    } else {
      const directDispatchDecision = buildDirectDispatchDecision(todoList);
      if (directDispatchDecision) {
        decision = directDispatchDecision;
      } else {
        try {
          const response = await routeRequest({
            model: state.orchestratorModel,
            input: `Objective: ${state.config.objective}\n\nWhat should I do next?`,
            instructions: systemPrompt,
            max_output_tokens: 2048,
            temperature: 0.1,
            text: { format: { type: 'json_schema' } },
            trace: buildToolTraceHooks(state, 'orchestrator', state.orchestratorModel),
          });

          if (response.usage.cost.total_cost > 0) {
            try {
              debitCredits(
                state.userId,
                response.usage.cost.total_cost,
                `Orchestrator loop iteration ${iteration}: ${state.id}`,
                'workflow',
                state.id
              );
              incrementWorkflowCredits(state, response.usage.cost.total_cost);
            } catch {
              // Non-critical
            }
          }

          let text = response.output_text.trim();
          if (text.startsWith('```')) {
            text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
          }

          const parsed = JSON.parse(text);
          const parseResult = OrchestratorDecisionSchema.safeParse(parsed);

          if (!parseResult.success) {
            logger.warn(
              { workflowId: state.id, iteration, error: parseResult.error.message },
              'Failed to parse orchestrator decision — attempting fallback'
            );
            decision = buildFallbackDecision(todoList);
          } else {
            decision = parseResult.data;
          }
        } catch (err) {
          logger.warn(
            { workflowId: state.id, iteration, error: (err as Error).message },
            'Orchestrator LLM call failed — attempting fallback'
          );
          decision = buildFallbackDecision(todoList);
        }
      }
    }

    recordStep(state, {
      step_type: 'orchestrator_message',
      model_name: state.orchestratorModel,
      message_content: decision.thinking,
      tool_name: null,
      tool_input: { iteration },
      tool_output: { actions: decision.actions.map(a => a.type) },
      subagent_id: 'orchestrator',
    });

    emit(state, {
      type: 'orchestrator_thinking',
      workflow_id: state.id,
      data: { thinking: decision.thinking, iteration, mode: classifyDecisionMode(decision.thinking) },
    });

    // Process actions
    const taskIdsToDispatch: string[] = [];
    let completionOutput: string | null = null;
    let delegateWritePrompt: string | null = null;

    logger.debug(
      { workflowId: state.id, iteration, actions: decision.actions },
      'Processing orchestrator actions'
    );

    for (const action of decision.actions) {
      if (action.type === 'dispatch') {
        logger.debug(
          { workflowId: state.id, taskIds: action.task_ids },
          'Dispatch action received'
        );
        for (const rawId of action.task_ids) {
          const taskId = resolveTaskId(rawId, state.id, todoList);
          const task = todoList.tasks.find(t => t.task_id === taskId);
          logger.debug(
            { workflowId: state.id, rawId, resolvedId: taskId, found: !!task },
            'Resolving task ID'
          );
          if (!task) {
            logger.warn({ workflowId: state.id, taskId: rawId }, 'dispatch: task not found');
            continue;
          }
          if (task.status !== 'pending') {
            logger.debug({ workflowId: state.id, taskId, status: task.status }, 'dispatch: skipping non-pending task');
            continue;
          }
          // Validate deps are satisfied
          const depsOk = task.depends_on.every(depId => {
            const dep = todoList.tasks.find(t => t.task_id === depId);
            return dep?.status === 'completed' || dep?.status === 'skipped';
          });
          if (!depsOk) {
            logger.warn({ workflowId: state.id, taskId }, 'dispatch: dependencies not yet satisfied');
            continue;
          }
          taskIdsToDispatch.push(taskId);
        }

      } else if (action.type === 'add_task') {
        try {
          const resolvedDependsOn = action.depends_on.map(d => resolveTaskId(d, state.id, todoList));
          const outputArtifact = action.output_artifact ?? inferOutputArtifact(action.agent_type as AgentType, action.task_id, action.description);
          const existingTask = findSemanticallyEquivalentTask(
            todoList,
            action.agent_type as AgentType,
            action.description,
            resolvedDependsOn,
            outputArtifact
          );

          if (existingTask) {
            emit(state, {
              type: 'task_reused',
              workflow_id: state.id,
              task_id: existingTask.task_id,
              data: {
                requested_task_id: action.task_id,
                description: existingTask.description,
                agent_type: existingTask.agent_type,
                reason: action.reason_generated ?? 'Semantically equivalent task already exists',
                origin: existingTask.origin,
              },
            });
            logger.info({ workflowId: state.id, existingTaskId: existingTask.task_id, requestedTaskId: action.task_id }, 'Reused semantically equivalent task');
            continue;
          }

          await addTodoTask(
            state.id,
            action.task_id,
            action.description,
            action.agent_type as AgentType,
            resolvedDependsOn,
            buildTaskMetadata({
              origin: 'runtime_generated',
              agentType: action.agent_type as AgentType,
              description: action.description,
              dependsOn: resolvedDependsOn,
              outputArtifact,
              reasonGenerated: action.reason_generated ?? 'Orchestrator identified missing work at runtime',
              supersedesTaskId: action.supersedes_task_id ? resolveTaskId(action.supersedes_task_id, state.id, todoList) : null,
            })
          );
          
          emit(state, {
            type: 'task_added',
            workflow_id: state.id,
            task_id: `${state.id}_${action.task_id}`,
            data: {
              description: action.description,
              agent_type: action.agent_type,
              depends_on: action.depends_on,
              origin: 'runtime_generated',
              output_artifact: outputArtifact,
              reason_generated: action.reason_generated ?? 'Orchestrator identified missing work at runtime',
              supersedes_task_id: action.supersedes_task_id ? resolveTaskId(action.supersedes_task_id, state.id, todoList) : null,
            },
          });
          logger.info({ workflowId: state.id, taskId: action.task_id }, 'Added new task dynamically');
        } catch (err) {
          logger.warn({ workflowId: state.id, error: (err as Error).message }, 'Failed to add task');
        }

      } else if (action.type === 'skip') {
        const taskId = resolveTaskId(action.task_id, state.id, todoList);
        const task = todoList.tasks.find(t => t.task_id === taskId);
        if (task && task.status === 'pending') {
          await skipTodoTask(state.id, taskId, action.reason);
          emit(state, {
            type: 'task_skipped',
            workflow_id: state.id,
            task_id: taskId,
            data: { reason: action.reason },
          });
        }

      } else if (action.type === 'complete') {
        completionOutput = action.output;
        break;

      } else if (action.type === 'delegate_write') {
        delegateWritePrompt = action.prompt;
        break;
      }
    }

    // Handle terminal completion
    if (completionOutput !== null) {
      state.status = 'completed';
      updateWorkflowStatus(state.id, 'completed', { completed_at: new Date().toISOString() });
      recordStep(state, {
        step_type: 'system_event',
        model_name: state.orchestratorModel,
        message_content: 'workflow_completed',
        tool_name: null,
        tool_input: null,
        tool_output: { output: completionOutput, total_credits: state.creditsConsumed },
        subagent_id: 'orchestrator',
      });
      emit(state, {
        type: 'workflow_completed',
        workflow_id: state.id,
        data: { output: completionOutput, total_credits: state.creditsConsumed },
      });
      cleanupSessions(state);
      return;
    }

    if (delegateWritePrompt !== null) {
      const refreshedTodoList = await getTodoList(state.id);
      const readyWriteTask = refreshedTodoList.tasks.find(task => task.agent_type === 'write' && task.status === 'pending' && areTaskDependenciesSatisfied(task, refreshedTodoList));
      const equivalentWriteTask = readyWriteTask ?? findSemanticallyEquivalentTask(refreshedTodoList, 'write', 'Write the final output', [], 'final_output');

      let writeTaskId: string;
      let writeTaskDescription: string;
      let writeTaskOrigin: 'planned' | 'runtime_generated';

      if (equivalentWriteTask && equivalentWriteTask.status === 'pending' && areTaskDependenciesSatisfied(equivalentWriteTask, refreshedTodoList)) {
        writeTaskId = equivalentWriteTask.task_id;
        writeTaskDescription = equivalentWriteTask.description;
        writeTaskOrigin = equivalentWriteTask.origin;

        emit(state, {
          type: 'task_reused',
          workflow_id: state.id,
          task_id: writeTaskId,
          data: {
            requested_task_id: 'write_final_output',
            description: writeTaskDescription,
            agent_type: 'write',
            reason: 'Reusing existing ready write task instead of generating a duplicate final-output task',
            origin: writeTaskOrigin,
          },
        });
      } else {
        const createdWriteTask = await addTodoTask(
          state.id,
          'write_final_output',
          'Write the final output',
          'write',
          [],
          buildTaskMetadata({
            origin: 'runtime_generated',
            agentType: 'write',
            description: 'Write the final output',
            dependsOn: [],
            outputArtifact: 'final_output',
            reasonGenerated: 'No existing ready write task could produce the requested final output',
          })
        );
        writeTaskId = createdWriteTask.task_id;
        writeTaskDescription = createdWriteTask.description;
        writeTaskOrigin = createdWriteTask.origin;
      }

      await updateTodoTaskStatus(state.id, writeTaskId, 'running');

      emit(state, {
        type: 'task_started',
        workflow_id: state.id,
        task_id: writeTaskId,
        data: { description: writeTaskDescription, task_type: 'write', origin: writeTaskOrigin, output_artifact: 'final_output' },
      });

      recordStep(state, {
        step_type: 'subagent_spawn',
        model_name: null,
        message_content: 'Delegating to write agent for final output',
        tool_name: null,
        tool_input: { agent_type: 'write' },
        tool_output: null,
        subagent_id: writeTaskId,
      });

      try {
        // Create a temporary todo task object for the write agent
        const writeTask: TodoTask = {
          task_id: writeTaskId,
          description: writeTaskDescription,
          agent_type: 'write',
          depends_on: [],
          status: 'running',
          origin: writeTaskOrigin,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        
        const agentCtx = buildAgentContext(state, writeTaskId);
        const writeResult = await dispatchToAgent(
          { task_id: writeTaskId, description: writeTask.description, agent_type: 'write', depends_on: [], status: 'running', origin: writeTaskOrigin, output_artifact: 'final_output' },
          delegateWritePrompt,
          agentCtx
        );
        const writeOutput = writeResult.output;

        await updateTodoTaskStatus(state.id, writeTaskId, 'completed', writeOutput);

        emit(state, {
          type: 'task_completed',
          workflow_id: state.id,
          task_id: writeTaskId,
          data: buildTaskCompletionPayload(writeResult),
        });

        state.status = 'completed';
        updateWorkflowStatus(state.id, 'completed', { completed_at: new Date().toISOString() });
        recordStep(state, {
          step_type: 'system_event',
          model_name: state.orchestratorModel,
          message_content: 'workflow_completed',
          tool_name: null,
          tool_input: null,
          tool_output: { output: writeOutput, total_credits: state.creditsConsumed },
          subagent_id: 'orchestrator',
        });
        emit(state, {
          type: 'workflow_completed',
          workflow_id: state.id,
          data: { output: writeOutput, total_credits: state.creditsConsumed, final_task_id: writeTaskId },
        });
      } catch (err) {
        const errMsg = (err as Error).message;
        await updateTodoTaskStatus(state.id, writeTaskId, 'failed', errMsg);
        state.status = 'failed';
        updateWorkflowStatus(state.id, 'failed', { error: `Write agent failed: ${errMsg}` });
        emit(state, {
          type: 'workflow_failed',
          workflow_id: state.id,
          data: { error: `Write agent failed: ${errMsg}` },
        });
      }

      cleanupSessions(state);
      return;
    }

    // Dispatch tasks in parallel
    logger.debug(
      { workflowId: state.id, taskCount: taskIdsToDispatch.length, tasks: taskIdsToDispatch },
      'Dispatching tasks'
    );
    
    if (taskIdsToDispatch.length > 0) {
      logger.info(
        { workflowId: state.id, taskCount: taskIdsToDispatch.length },
        'Starting task dispatch'
      );
      const taskPromises = taskIdsToDispatch.map(async (taskId) => {
        logger.debug({ workflowId: state.id, taskId }, 'Starting task dispatch loop');
        const task = todoList.tasks.find(t => t.task_id === taskId)!;
        logger.debug({ workflowId: state.id, taskId, agentType: task.agent_type }, 'Found task, updating status');
        await updateTodoTaskStatus(state.id, taskId, 'running');
        logger.debug({ workflowId: state.id, taskId }, 'Status updated to running');

        recordStep(state, {
          step_type: 'subagent_spawn',
          model_name: null,
          message_content: task.description,
          tool_name: null,
          tool_input: { agent_type: task.agent_type, depends_on: task.depends_on },
          tool_output: null,
          subagent_id: taskId,
        });

        emit(state, {
          type: 'task_started',
          workflow_id: state.id,
          task_id: taskId,
          data: { description: task.description, task_type: task.agent_type, origin: task.origin, output_artifact: task.output_artifact },
        });

        const prompt = buildAgentTaskPrompt(state, task, todoList);
        const agentCtx = buildAgentContext(state, taskId);

        try {
          const result = await dispatchToAgent(
            {
              task_id: taskId,
              description: task.description,
              agent_type: task.agent_type,
              depends_on: task.depends_on,
              status: 'running',
              origin: task.origin,
              semantic_key: task.semantic_key,
              output_artifact: task.output_artifact,
              reason_generated: task.reason_generated,
              supersedes_task_id: task.supersedes_task_id,
            },
            prompt,
            agentCtx
          );
          const output = result.output;
          
          await updateTodoTaskStatus(state.id, taskId, 'completed', output);
          state.taskOutputs.set(taskId, output);

          recordStep(state, {
            step_type: 'subagent_message',
            model_name: null,
            message_content: output.substring(0, 500),
            tool_name: null,
            tool_input: null,
            tool_output: null,
            subagent_id: taskId,
          });

          emit(state, {
            type: 'task_completed',
            workflow_id: state.id,
            task_id: taskId,
            data: buildTaskCompletionPayload(result),
          });
        } catch (err) {
          const errMsg = (err as Error).message;
          await updateTodoTaskStatus(state.id, taskId, 'failed', errMsg);
          state.taskOutputs.set(taskId, `[failed: ${errMsg}]`);
          
          recordStep(state, {
            step_type: 'system_event',
            model_name: null,
            message_content: 'task_failed',
            tool_name: null,
            tool_input: null,
            tool_output: { error: errMsg },
            subagent_id: taskId,
          });
          emit(state, {
            type: 'task_failed',
            workflow_id: state.id,
            task_id: taskId,
            data: { error: errMsg },
          });
          logger.warn({ workflowId: state.id, taskId, error: errMsg }, 'Sub-agent task failed');
        }
      });

      logger.info({ workflowId: state.id, taskCount: taskPromises.length }, 'Waiting for all tasks to complete');
      await Promise.all(taskPromises);
      logger.info({ workflowId: state.id }, 'All tasks completed');
    } else if (completionOutput === null && delegateWritePrompt === null) {
      // Nothing dispatched and no terminal action
      if (allTasksSettled(todoList)) {
        logger.debug({ workflowId: state.id, iteration }, 'All tasks settled, expecting orchestrator to complete next iteration');
      } else {
        const hasInProgress = todoList.tasks.some(t => t.status === 'running');
        if (!hasInProgress) {
          logger.warn(
            { workflowId: state.id, iteration },
            'No tasks dispatched and no terminal action — orchestrator may be stuck'
          );
        }
      }
    }
  }

  // Max iterations reached
  if (state.status === 'executing') {
    state.status = 'failed';
    const msg = `Workflow exceeded maximum iteration limit (${MAX_LOOP_ITERATIONS})`;
    updateWorkflowStatus(state.id, 'failed', { error: msg });
    emit(state, { type: 'workflow_failed', workflow_id: state.id, data: { error: msg } });
    logger.warn({ workflowId: state.id }, msg);
  }

  cleanupSessions(state);
}

/** Build a fallback decision when the orchestrator LLM response can't be parsed */
function buildFallbackDecision(todoList: TodoList): OrchestratorDecision {
  const readyTasks = getReadyTasks(todoList);

  if (allTasksSettled(todoList)) {
    const preferredOutput = [...todoList.tasks]
      .reverse()
      .find(task => task.status === 'completed' && task.output && task.agent_type === 'write')?.output;
    const outputs = preferredOutput ?? todoList.tasks
      .filter(t => t.status === 'completed' && t.output)
      .map(t => t.output)
      .join('\n\n---\n\n');
    return {
      thinking: 'Fallback: all tasks settled, producing output from completed task results.',
      actions: [{ type: 'complete', output: outputs || 'Workflow completed.' }],
    };
  }

  if (readyTasks.length > 0) {
    return {
      thinking: 'Fallback: dispatching ready tasks.',
      actions: [{ type: 'dispatch', task_ids: readyTasks.map(t => t.task_id) }],
    };
  }

  return {
    thinking: 'Fallback: no actions available.',
    actions: [],
  };
}

function buildAgentContext(state: WorkflowState, taskId: string): AgentExecutionContext {
  return {
    workflowId: state.id,
    userId: state.userId,
    orchestratorModel: state.orchestratorModel,
    config: state.config,
    sandboxSessionIds: state.sandboxSessionIds,
    creditsCallback: (amount) => incrementWorkflowCredits(state, amount),
    trace: buildToolTraceHooks(state, taskId),
  };
}

function cleanupSessions(state: WorkflowState): void {
  for (const sid of state.sandboxSessionIds) {
    try {
      terminateSession(sid);
    } catch {
      // Non-critical
    }
  }
}

// ── Workflow control ──

export function pauseWorkflow(workflowId: string): void {
  const state = workflows.get(workflowId);
  if (!state) throw new WorkflowError(`Workflow not found: ${workflowId}`);
  if (state.status !== 'executing') {
    throw new WorkflowError(`Cannot pause workflow in status: ${state.status}`);
  }

  state.status = 'paused';
  updateWorkflowStatus(workflowId, 'paused');
}

export async function resumeWorkflow(
  workflowId: string,
  approvals?: Array<{ task_id: string; approved: boolean; feedback?: string }>
): Promise<void> {
  const state = workflows.get(workflowId);
  if (!state) throw new WorkflowError(`Workflow not found: ${workflowId}`);
  if (state.status !== 'paused') {
    throw new WorkflowError(`Cannot resume workflow in status: ${state.status}`);
  }

  if (approvals) {
    for (const approval of approvals) {
      if (approval.approved) {
        await updateTodoTaskStatus(workflowId, approval.task_id, 'completed', approval.feedback ?? 'Approved');
        state.taskOutputs.set(approval.task_id, approval.feedback ?? 'Approved');
      } else {
        await updateTodoTaskStatus(workflowId, approval.task_id, 'failed', approval.feedback ?? 'Rejected');
      }
    }
  }

  state.status = 'executing';
  updateWorkflowStatus(workflowId, 'executing');

  runWorkflow(state).catch((err) => {
    logger.error({ workflowId, error: (err as Error).message }, 'Workflow execution failed after resume');
  });
}

export function cancelWorkflow(workflowId: string): void {
  const state = workflows.get(workflowId);
  if (!state) throw new WorkflowError(`Workflow not found: ${workflowId}`);

  state.abortController.abort();
  state.status = 'cancelled';
  updateWorkflowStatus(workflowId, 'cancelled');

  cleanupSessions(state);

  const db = getDb();
  db.prepare(
    "UPDATE tasks SET status = 'cancelled' WHERE workflow_id = ? AND status IN ('pending', 'running', 'blocked')"
  ).run(workflowId);

  emit(state, {
    type: 'workflow_failed',
    workflow_id: workflowId,
    data: { error: 'Workflow cancelled by user' },
  });
  recordStep(state, {
    step_type: 'system_event',
    model_name: state.orchestratorModel,
    message_content: 'workflow_cancelled',
    tool_name: null,
    tool_input: null,
    tool_output: { error: 'Workflow cancelled by user' },
    subagent_id: 'orchestrator',
  });

  logger.info({ workflowId }, 'Workflow cancelled');
}

export function getWorkflowState(workflowId: string): WorkflowState | null {
  return workflows.get(workflowId) ?? null;
}

export function getWorkflowEmitter(workflowId: string): EventEmitter | null {
  return workflows.get(workflowId)?.emitter ?? null;
}

// ── Query helpers ──

export interface WorkflowSummary {
  id: string;
  objective: string;
  user_prompt?: string;
  orchestrator_model?: string | null;
  status: string;
  plan: import('@orchestrator/shared').DAGPlan | null;
  credits_consumed: number;
  started_at?: string | null;
  ended_at?: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  tasks: TaskSummary[];
}

export interface TaskSummary {
  id: string;
  task_type: string;
  description: string | null;
  status: string;
  output_preview: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export function getWorkflowDetails(workflowId: string): WorkflowSummary | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM workflows WHERE id = ?').get(workflowId) as Record<string, unknown> | undefined;
  if (!row) return null;

  const tasks = db.prepare('SELECT * FROM tasks WHERE workflow_id = ? ORDER BY created_at').all(workflowId) as Array<Record<string, unknown>>;

  return {
    id: row['id'] as string,
    objective: row['objective'] as string,
    user_prompt: (row['user_prompt'] as string) ?? (row['objective'] as string),
    orchestrator_model: (row['orchestrator_model'] as string) ?? null,
    status: row['status'] as string,
    plan: row['plan'] ? JSON.parse(row['plan'] as string) : null,
    credits_consumed: row['credits_consumed'] as number,
    started_at: (row['started_at'] as string) ?? null,
    ended_at: (row['ended_at'] as string) ?? null,
    created_at: row['created_at'] as string,
    updated_at: row['updated_at'] as string,
    completed_at: (row['completed_at'] as string) ?? null,
    tasks: tasks.map((t) => ({
      id: t['id'] as string,
      task_type: t['task_type'] as string,
      description: (t['description'] as string) ?? null,
      status: t['status'] as string,
      output_preview: t['output'] ? (t['output'] as string).substring(0, 500) : null,
      started_at: (t['started_at'] as string) ?? null,
      completed_at: (t['completed_at'] as string) ?? null,
    })),
  };
}

export function listWorkflows(
  userId: string,
  options: { page: number; limit: number; status?: string }
): { workflows: WorkflowSummary[]; total: number } {
  const db = getDb();
  const offset = (options.page - 1) * options.limit;

  let whereClause = 'WHERE user_id = ?';
  const params: unknown[] = [userId];
  if (options.status) {
    whereClause += ' AND status = ?';
    params.push(options.status);
  }

  const total = (
    db.prepare(`SELECT COUNT(*) as count FROM workflows ${whereClause}`).get(...params) as { count: number }
  ).count;

  const rows = db
    .prepare(`SELECT * FROM workflows ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, options.limit, offset) as Array<Record<string, unknown>>;

  const workflowSummaries = rows.map((row) => {
    const tasks = db.prepare('SELECT * FROM tasks WHERE workflow_id = ? ORDER BY created_at').all(row['id']) as Array<Record<string, unknown>>;

    return {
      id: row['id'] as string,
      objective: row['objective'] as string,
      user_prompt: (row['user_prompt'] as string) ?? (row['objective'] as string),
      orchestrator_model: (row['orchestrator_model'] as string) ?? null,
      status: row['status'] as string,
      plan: row['plan'] ? JSON.parse(row['plan'] as string) : null,
      credits_consumed: row['credits_consumed'] as number,
      started_at: (row['started_at'] as string) ?? null,
      ended_at: (row['ended_at'] as string) ?? null,
      created_at: row['created_at'] as string,
      updated_at: row['updated_at'] as string,
      completed_at: (row['completed_at'] as string) ?? null,
      tasks: tasks.map((t) => ({
        id: t['id'] as string,
        task_type: t['status'] as string,
        description: (t['description'] as string) ?? null,
        status: t['status'] as string,
        output_preview: t['output'] ? (t['output'] as string).substring(0, 500) : null,
        started_at: (t['started_at'] as string) ?? null,
        completed_at: (t['completed_at'] as string) ?? null,
      })),
    };
  });

  return { workflows: workflowSummaries, total };
}

export function getWorkflowTrace(workflowId: string): WorkflowTraceStep[] {
  return readWorkflowTrace(workflowId);
}
