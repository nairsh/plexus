import { EventEmitter } from 'node:events';
import {
  getDb,
  logger,
  WorkflowError,
  DAGPlanSchema,
} from '@orchestrator/shared';
import type {
  WorkflowConfig,
  WorkflowEvent,
  DAGPlan,
  DAGTask,
  ToolTraceHooks,
  WorkflowTraceStep,
} from '@orchestrator/shared';
import {
  routeRequest,
  executeWebSearch,
  resolveOrchestratorModel,
  getSubagentModel,
} from '@orchestrator/model-router';
import { debitCredits } from '@orchestrator/billing';
import { createSession, execute as sandboxExecute, terminateSession } from '@orchestrator/sandbox';
import { getWorkflowTrace as readWorkflowTrace, logWorkflowStep } from './workflowTrace.js';

// ── In-memory state ──

interface WorkflowState {
  id: string;
  userId: string;
  config: WorkflowConfig;
  plan: DAGPlan | null;
  orchestratorModel: string;
  status: 'pending' | 'planning' | 'executing' | 'paused' | 'completed' | 'failed' | 'cancelled';
  taskOutputs: Map<string, string>;
  emitter: EventEmitter;
  abortController: AbortController;
  sandboxSessionIds: string[];
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

function updateTaskStatus(
  taskId: string,
  status: string,
  extra?: Record<string, unknown>
) {
  const db = getDb();
  const sets = ['status = ?'];
  const params: unknown[] = [status];

  if (status === 'running') {
    sets.push("started_at = datetime('now')");
  }
  if (status === 'completed' || status === 'failed') {
    sets.push("completed_at = datetime('now')");
  }
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      sets.push(`${key} = ?`);
      params.push(typeof value === 'string' ? value : JSON.stringify(value));
    }
  }

  params.push(taskId);
  db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

// ── Planner prompt ──

const PLANNER_SYSTEM_PROMPT = `You are the orchestrator model for a DAG-based AI workflow system. Turn a user objective into executable sub-tasks for specialized sub-agents.

## Task Types
- web_search: Use the platform search tools for current information
- llm_completion: Delegate analysis, synthesis, or writing to a sub-agent (requires model field)
- code_execution: Run Python/JavaScript/SQL inside the sandbox workspace
- file_operation: Read or write files inside the sandbox workspace
- human_approval: Pause for a human checkpoint

## Execution Model
- You are only planning. The runtime executes tasks, handles dependencies, and logs every step.
- Sub-agents may use only the tools explicitly attached to their task.
- Do not assume browser automation, external APIs, or capabilities that are not represented as task types or tools.
- Use web_search for discovery and llm_completion for reasoning over previous task outputs.

## CRITICAL: Use EXACT Field Names

Each task MUST use these EXACT field names:
- "task_id": string (snake_case, e.g., "research_tesla")
- "parent_task_ids": array of strings (empty [] for independent tasks)
- "task_type": string (one of: web_search, llm_completion, code_execution, file_operation, human_approval)
- "description": string (what to do)
- "model": string or null (REQUIRED for llm_completion, use null for others)
- "tools": array or null
- "input_template": string (use {{task_id}} to reference parent outputs)

## Model Selection for llm_completion
- Cheap/fast: "litellm/gemini-3.1-flash-lite-preview"
- Balanced: "litellm/gemini-3-flash-preview"
- Smart: "litellm/ali-kimi-k2.5"

## Example Response Format

{
  "tasks": [
    {
      "task_id": "search_tesla",
      "parent_task_ids": [],
      "task_type": "web_search",
      "description": "Find Tesla market cap",
      "model": null,
      "tools": [{"type": "web_search"}],
      "input_template": "Search Tesla market cap"
    },
    {
      "task_id": "analyze",
      "parent_task_ids": ["search_tesla"],
      "task_type": "llm_completion",
      "description": "Analyze the data",
      "model": "litellm/gemini-3.1-flash-lite-preview",
      "tools": [],
      "input_template": "Analyze: {{search_tesla}}"
    }
  ]
}

## Rules
1. Use empty parent_task_ids [] for parallel tasks
2. For llm_completion tasks, ALWAYS specify a model (never omit)
3. For non-llm tasks, use "model": null
4. Keep tools minimal and relevant to the task
5. Max 5-7 tasks total
6. Prefer parallelism over chains

Respond with ONLY valid JSON matching the format above.`;

// ── Engine API ──

export async function planWorkflow(
  userId: string,
  config: WorkflowConfig
): Promise<{ workflowId: string; plan: DAGPlan }> {
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
    plan: null,
    orchestratorModel: plannerModel,
    status: 'planning',
    taskOutputs: new Map(),
    emitter: new EventEmitter(),
    abortController: new AbortController(),
    sandboxSessionIds: [],
  };
  state.emitter.setMaxListeners(50);
  workflows.set(workflowId, state);

  recordStep(state, {
    step_type: 'orchestrator_message',
    model_name: plannerModel,
    message_content: config.objective,
    tool_name: null,
    tool_input: null,
    tool_output: null,
    subagent_id: 'orchestrator',
  });

  try {
    const response = await routeRequest({
      model: plannerModel,
      input: `Objective: ${config.objective}`,
      instructions: PLANNER_SYSTEM_PROMPT,
      max_output_tokens: 4096,
      temperature: 0.2,
      text: { format: { type: 'json_schema' } },
      trace: buildToolTraceHooks(state, 'orchestrator', plannerModel),
    });

    recordStep(state, {
      step_type: 'system_event',
      model_name: plannerModel,
      message_content: 'planner_response',
      tool_name: null,
      tool_input: null,
      tool_output: response.output_text,
      subagent_id: 'orchestrator',
    });

    // Debit planning cost
    if (response.usage.cost.total_cost > 0) {
      try {
        debitCredits(userId, response.usage.cost.total_cost, `Workflow planning: ${workflowId}`, 'workflow', workflowId);
      } catch {
        // Non-critical
      }
    }

    // Parse the plan from the LLM response
    let planJson: unknown;
    try {
      // Extract JSON from the response text (handle markdown code blocks)
      let text = response.output_text.trim();
      if (text.startsWith('```')) {
        text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }
      planJson = JSON.parse(text);
    } catch {
      throw new WorkflowError(`Failed to parse planner response as JSON: ${response.output_text.substring(0, 200)}`);
    }

    const parseResult = DAGPlanSchema.safeParse(planJson);
    if (!parseResult.success) {
      throw new WorkflowError(`Invalid DAG plan: ${parseResult.error.message}`);
    }

    const plan = parseResult.data;
    state.plan = plan;
    state.status = 'executing';

    recordStep(state, {
      step_type: 'system_event',
      model_name: plannerModel,
      message_content: 'planning_complete',
      tool_name: null,
      tool_input: null,
      tool_output: plan,
      subagent_id: 'orchestrator',
    });

    // Persist plan and tasks
    updateWorkflowStatus(workflowId, 'executing', { plan: JSON.stringify(plan) });

    for (const task of plan.tasks) {
      db.prepare(
        `INSERT INTO tasks (id, workflow_id, parent_task_ids, task_type, description, model, tools, input_context, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
      ).run(
        task.task_id,
        workflowId,
        JSON.stringify(task.parent_task_ids),
        task.task_type,
        task.description,
        task.model || null,
        task.tools ? JSON.stringify(task.tools) : null,
        task.input_template
      );
    }

    emit(state, {
      type: 'planning_complete',
      workflow_id: workflowId,
      data: { task_count: plan.tasks.length, tasks: plan.tasks.map((t) => ({ id: t.task_id, type: t.task_type, description: t.description })) },
    });

    logger.info({ workflowId, taskCount: plan.tasks.length }, 'Workflow planned');

    return { workflowId, plan };
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
  if (!state.plan) throw new WorkflowError('Workflow has no plan');

  // Queue to relay events from the emitter into the async iterable
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

  // Start execution in background
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
        // Drain remaining events
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
    await executionPromise.catch(() => {}); // Ensure we don't get unhandled rejections
  }
}

async function runWorkflow(state: WorkflowState): Promise<void> {
  const plan = state.plan!;
  const taskMap = new Map<string, DAGTask>();
  const taskStatuses = new Map<string, string>();

  for (const task of plan.tasks) {
    taskMap.set(task.task_id, task);
    taskStatuses.set(task.task_id, 'pending');
  }

  const MAX_RETRIES = 2;

  while (state.status === 'executing') {
    if (state.abortController.signal.aborted) {
      state.status = 'cancelled';
      updateWorkflowStatus(state.id, 'cancelled');
      emit(state, { type: 'workflow_failed', workflow_id: state.id, data: { error: 'Workflow cancelled' } });
      return;
    }

    // Find ready tasks (all parents completed)
    const readyTasks: DAGTask[] = [];
    for (const task of plan.tasks) {
      if (taskStatuses.get(task.task_id) !== 'pending') continue;

      const allParentsDone = task.parent_task_ids.every(
        (pid) => taskStatuses.get(pid) === 'completed'
      );
      const anyParentFailed = task.parent_task_ids.some(
        (pid) => taskStatuses.get(pid) === 'failed'
      );

      if (anyParentFailed) {
        taskStatuses.set(task.task_id, 'failed');
        updateTaskStatus(task.task_id, 'failed', { output: JSON.stringify({ error: 'Parent task failed' }) });
        continue;
      }

      if (allParentsDone) {
        readyTasks.push(task);
      }
    }

    if (readyTasks.length === 0) {
      // Check if all tasks are done
      const allDone = plan.tasks.every(
        (t) => taskStatuses.get(t.task_id) === 'completed' || taskStatuses.get(t.task_id) === 'failed'
      );
      if (allDone) break;

      // Check for deadlock (some tasks are pending but none are ready)
      const hasPending = plan.tasks.some((t) => taskStatuses.get(t.task_id) === 'pending');
      const hasRunning = plan.tasks.some((t) => taskStatuses.get(t.task_id) === 'running');
      if (hasPending && !hasRunning) {
        // Deadlock — fail remaining
        for (const task of plan.tasks) {
          if (taskStatuses.get(task.task_id) === 'pending') {
            taskStatuses.set(task.task_id, 'failed');
            updateTaskStatus(task.task_id, 'failed', { output: JSON.stringify({ error: 'Deadlocked: unresolvable dependencies' }) });
          }
        }
        break;
      }
      // Wait a bit for running tasks to finish
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }

    // Check if any ready task is human_approval — pause workflow
    const approvalTask = readyTasks.find((t) => t.task_type === 'human_approval');
    if (approvalTask && state.config.human_approval) {
      taskStatuses.set(approvalTask.task_id, 'blocked');
      updateTaskStatus(approvalTask.task_id, 'blocked');
      state.status = 'paused';
      updateWorkflowStatus(state.id, 'paused');
      recordStep(state, {
        step_type: 'system_event',
        model_name: state.orchestratorModel,
        message_content: 'human_approval_required',
        tool_name: null,
        tool_input: { task_id: approvalTask.task_id },
        tool_output: { description: approvalTask.description },
        subagent_id: approvalTask.task_id,
      });
      emit(state, {
        type: 'human_approval_required',
        workflow_id: state.id,
        task_id: approvalTask.task_id,
        data: { description: approvalTask.description },
      });
      return; // Will be resumed via resumeWorkflow
    }

    // Execute ready tasks in parallel
    const promises = readyTasks.map(async (task) => {
      taskStatuses.set(task.task_id, 'running');
      updateTaskStatus(task.task_id, 'running');
      recordStep(state, {
        step_type: 'subagent_spawn',
        model_name: task.model ?? null,
        message_content: task.description,
        tool_name: null,
        tool_input: {
          task_type: task.task_type,
          parents: task.parent_task_ids,
        },
        tool_output: null,
        subagent_id: task.task_id,
      });
      emit(state, {
        type: 'task_started',
        workflow_id: state.id,
        task_id: task.task_id,
        data: { description: task.description, task_type: task.task_type },
      });

      let lastError: Error | null = null;
      const retries = task.task_type === 'human_approval' ? 0 : MAX_RETRIES;

      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const output = await executeTask(state, task, attempt);
          state.taskOutputs.set(task.task_id, output);
          taskStatuses.set(task.task_id, 'completed');
          updateTaskStatus(task.task_id, 'completed', { output });
          recordStep(state, {
            step_type: 'subagent_message',
            model_name: task.model ?? null,
            message_content: output,
            tool_name: null,
            tool_input: null,
            tool_output: null,
            subagent_id: task.task_id,
          });

          emit(state, {
            type: 'task_completed',
            workflow_id: state.id,
            task_id: task.task_id,
            data: { output_preview: output.substring(0, 500) },
          });
          return;
        } catch (err) {
          lastError = err as Error;
          if (attempt < retries) {
            logger.warn(
              { workflowId: state.id, taskId: task.task_id, attempt, error: (err as Error).message },
              'Task failed, retrying'
            );
          }
        }
      }

      // All retries exhausted
      taskStatuses.set(task.task_id, 'failed');
      updateTaskStatus(task.task_id, 'failed', {
        output: JSON.stringify({ error: lastError?.message ?? 'Unknown error' }),
        retry_count: retries,
      });
      recordStep(state, {
        step_type: 'system_event',
        model_name: task.model ?? null,
        message_content: 'task_failed',
        tool_name: null,
        tool_input: null,
        tool_output: { error: lastError?.message ?? 'Unknown error' },
        subagent_id: task.task_id,
      });

      emit(state, {
        type: 'task_failed',
        workflow_id: state.id,
        task_id: task.task_id,
        data: { error: lastError?.message },
      });
    });

    await Promise.all(promises);
  }

  // Cleanup sandbox sessions
  for (const sid of state.sandboxSessionIds) {
    try {
      terminateSession(sid);
    } catch {
      // Non-critical
    }
  }

  // Check final status
  const anyFailed = plan.tasks.some((t) => taskStatuses.get(t.task_id) === 'failed');
  const allCompleted = plan.tasks.every(
    (t) => taskStatuses.get(t.task_id) === 'completed' || taskStatuses.get(t.task_id) === 'failed'
  );

  if (allCompleted && !anyFailed) {
    state.status = 'completed';
    // Assemble final output from leaf nodes
    const leafTasks = plan.tasks.filter(
      (t) => !plan.tasks.some((other) => other.parent_task_ids.includes(t.task_id))
    );
    const finalOutput = leafTasks
      .map((t) => state.taskOutputs.get(t.task_id) ?? '')
      .filter(Boolean)
      .join('\n\n---\n\n');

    updateWorkflowStatus(state.id, 'completed', {
      completed_at: new Date().toISOString(),
    });

    // Compute total credits consumed
    const db = getDb();
    const row = db.prepare('SELECT SUM(CAST(json_extract(cost, "$.total_cost") AS REAL)) as total FROM tasks WHERE workflow_id = ?').get(state.id) as { total: number | null } | undefined;
    const totalCredits = row?.total ?? 0;
    db.prepare('UPDATE workflows SET credits_consumed = ? WHERE id = ?').run(totalCredits, state.id);

      emit(state, {
        type: 'workflow_completed',
        workflow_id: state.id,
        data: { output: finalOutput.substring(0, 5000), total_credits: totalCredits },
      });
      recordStep(state, {
        step_type: 'system_event',
        model_name: state.orchestratorModel,
        message_content: 'workflow_completed',
        tool_name: null,
        tool_input: null,
        tool_output: { output: finalOutput, total_credits: totalCredits },
        subagent_id: 'orchestrator',
      });

      logger.info({ workflowId: state.id, totalCredits }, 'Workflow completed');
    } else if (anyFailed) {
      state.status = 'failed';
      const failedTasks = plan.tasks.filter((t) => taskStatuses.get(t.task_id) === 'failed').map((t) => t.task_id);
      updateWorkflowStatus(state.id, 'failed', { error: `Tasks failed: ${failedTasks.join(', ')}` });
      recordStep(state, {
        step_type: 'system_event',
        model_name: state.orchestratorModel,
        message_content: 'workflow_failed',
        tool_name: null,
        tool_input: null,
        tool_output: { failed_tasks: failedTasks },
        subagent_id: 'orchestrator',
      });
      emit(state, {
        type: 'workflow_failed',
        workflow_id: state.id,
      data: { failed_tasks: failedTasks },
    });
  }
}

async function executeTask(
  state: WorkflowState,
  task: DAGTask,
  attempt: number
): Promise<string> {
  // Resolve input template — replace {{task_id}} with parent outputs
  let input = task.input_template;
  for (const parentId of task.parent_task_ids) {
    const parentOutput = state.taskOutputs.get(parentId) ?? '';
    input = input.replace(new RegExp(`\\{\\{${parentId}\\}\\}`, 'g'), parentOutput);
  }

  recordStep(state, {
    step_type: 'subagent_message',
    model_name: task.model ?? null,
    message_content: input,
    tool_name: null,
    tool_input: { attempt },
    tool_output: null,
    subagent_id: task.task_id,
  });

  switch (task.task_type) {
    case 'llm_completion': {
      const model = task.model === 'auto' || !task.model
        ? getSubagentModel('llm_completion', state.orchestratorModel)
        : task.model;

      const response = await routeRequest({
        model,
        input,
        tools: task.tools ?? undefined,
        max_output_tokens: 4096,
        trace: buildToolTraceHooks(state, task.task_id, model),
      });

      // Track cost
      if (response.usage.cost.total_cost > 0) {
        try {
          debitCredits(
            state.userId,
            response.usage.cost.total_cost,
            `Workflow task: ${task.task_id}`,
            'workflow',
            state.id
          );
          updateTaskStatus(task.task_id, 'running', {
            cost: JSON.stringify(response.usage.cost),
          });
        } catch {
          // Non-critical
        }
      }

      return response.output_text;
    }

    case 'web_search': {
      recordStep(state, {
        step_type: 'subagent_tool_call',
        model_name: task.model ?? null,
        message_content: null,
        tool_name: 'search_web',
        tool_input: { query: input },
        tool_output: null,
        subagent_id: task.task_id,
      });
      const results = await executeWebSearch(input);
      recordStep(state, {
        step_type: 'subagent_tool_result',
        model_name: task.model ?? null,
        message_content: null,
        tool_name: 'search_web',
        tool_input: { query: input },
        tool_output: results,
        subagent_id: task.task_id,
      });
      return typeof results === 'string' ? results : JSON.stringify(results);
    }

    case 'code_execution': {
      // Determine language from the input
      let language: 'python' | 'javascript' | 'sql' = 'python';
      if (input.includes('javascript') || input.includes('node') || input.includes('console.log')) {
        language = 'javascript';
      } else if (input.includes('SELECT') || input.includes('CREATE TABLE')) {
        language = 'sql';
      }

      // First, have an LLM generate the code
      const plannerModel = getSubagentModel('code_execution_planner', state.orchestratorModel);
      const codeResponse = await routeRequest({
        model: plannerModel,
        input: `Write ${language} code to accomplish the following. Return ONLY the code, no explanations or markdown:\n\n${input}`,
        max_output_tokens: 4096,
        temperature: 0.1,
        trace: buildToolTraceHooks(state, task.task_id, plannerModel),
      });

      let code = codeResponse.output_text.trim();
      // Strip markdown code blocks if present
      if (code.startsWith('```')) {
        code = code.replace(/^```(?:\w+)?\n?/, '').replace(/\n?```$/, '');
      }

      // Create sandbox session
      const chatId = state.id;
      recordStep(state, {
        step_type: 'subagent_tool_call',
        model_name: plannerModel,
        message_content: null,
        tool_name: 'sandbox_execute',
        tool_input: { language, chat_id: chatId, task_id: task.task_id },
        tool_output: null,
        subagent_id: task.task_id,
      });
      const session = await createSession(state.userId, { language, chat_id: chatId, task_id: task.task_id });
      state.sandboxSessionIds.push(session.id);

      const result = await sandboxExecute(session.id, code, 120);
      terminateSession(session.id);
      recordStep(state, {
        step_type: 'subagent_tool_result',
        model_name: plannerModel,
        message_content: null,
        tool_name: 'sandbox_execute',
        tool_input: { language, chat_id: chatId, task_id: task.task_id },
        tool_output: result,
        subagent_id: task.task_id,
      });

      if (result.exit_code !== 0) {
        throw new Error(`Code execution failed (exit ${result.exit_code}): ${result.stderr}`);
      }

      return result.stdout || '(no output)';
    }

    case 'file_operation': {
      // Use code execution to handle file ops
      const filePlannerModel = getSubagentModel('file_operation_planner', state.orchestratorModel);
      const chatId = state.id;
      recordStep(state, {
        step_type: 'subagent_tool_call',
        model_name: filePlannerModel,
        message_content: null,
        tool_name: 'sandbox_execute',
        tool_input: { language: 'python', chat_id: chatId, task_id: task.task_id },
        tool_output: null,
        subagent_id: task.task_id,
      });
      const session = await createSession(state.userId, { language: 'python', chat_id: chatId, task_id: task.task_id });
      state.sandboxSessionIds.push(session.id);

      const result = await sandboxExecute(session.id, input, 60);
      terminateSession(session.id);
      recordStep(state, {
        step_type: 'subagent_tool_result',
        model_name: filePlannerModel,
        message_content: null,
        tool_name: 'sandbox_execute',
        tool_input: { language: 'python', chat_id: chatId, task_id: task.task_id },
        tool_output: result,
        subagent_id: task.task_id,
      });

      return result.stdout || result.stderr || '(no output)';
    }

    case 'human_approval': {
      // This should have been caught before reaching here if human_approval is enabled
      // If not, just auto-approve
      return 'Auto-approved (human_approval not enabled)';
    }

    default:
      throw new Error(`Unknown task type: ${task.task_type}`);
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

  // Process approvals
  if (approvals) {
    const db = getDb();
    for (const approval of approvals) {
      if (approval.approved) {
        db.prepare("UPDATE tasks SET status = 'completed', output = ? WHERE id = ? AND workflow_id = ?").run(
          JSON.stringify({ approved: true, feedback: approval.feedback }),
          approval.task_id,
          workflowId
        );
        state.taskOutputs.set(approval.task_id, approval.feedback ?? 'Approved');
        recordStep(state, {
          step_type: 'system_event',
          model_name: state.orchestratorModel,
          message_content: 'human_approval_approved',
          tool_name: null,
          tool_input: { task_id: approval.task_id },
          tool_output: { feedback: approval.feedback ?? 'Approved' },
          subagent_id: approval.task_id,
        });
      } else {
        db.prepare("UPDATE tasks SET status = 'failed', output = ? WHERE id = ? AND workflow_id = ?").run(
          JSON.stringify({ approved: false, feedback: approval.feedback }),
          approval.task_id,
          workflowId
        );
        recordStep(state, {
          step_type: 'system_event',
          model_name: state.orchestratorModel,
          message_content: 'human_approval_rejected',
          tool_name: null,
          tool_input: { task_id: approval.task_id },
          tool_output: { feedback: approval.feedback ?? 'Rejected' },
          subagent_id: approval.task_id,
        });
      }
    }
  }

  state.status = 'executing';
  updateWorkflowStatus(workflowId, 'executing');

  // Re-run the workflow (it will pick up from where it left off based on task statuses)
  // Fire and forget — events will be emitted
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

  // Terminate any sandbox sessions
  for (const sid of state.sandboxSessionIds) {
    try {
      terminateSession(sid);
    } catch {
      // Non-critical
    }
  }

  // Cancel all pending/running tasks
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
  plan: DAGPlan | null;
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
        task_type: t['task_type'] as string,
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
