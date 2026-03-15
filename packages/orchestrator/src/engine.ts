import { EventEmitter } from 'node:events';
import { getDb, WorkflowError } from '@orchestrator/shared';
import type {
  WorkflowConfig,
  WorkflowEvent,
  OrchestratorTask,
  AgentType,
  Tool,
  OutputBlock,
  ToolTraceHooks,
  SubagentExecutionResult,
  ConversationMessage,
  WorkflowTraceStep,
} from '@orchestrator/shared';
import { routeRequest, resolveOrchestratorModel } from '@orchestrator/model-router';
import { debitCredits } from '@orchestrator/billing';
import { terminateSession } from '@orchestrator/sandbox';
import { dispatchToAgent } from './agents.js';
import type { AgentExecutionContext } from './agents.js';
import { getWorkflowTrace as readWorkflowTrace, logWorkflowStep } from './workflowTrace.js';
import {
  createWorkItem,
  listWorkItems,
  getWorkItem,
  updateWorkItem,
  resolveWorkItemId,
  type WorkItem,
  type WorkItemStatus,
} from './workItems.js';
import { loadPrompt, formatConversationHistory } from './promptLoader.js';

const MAX_TURNS = 60;

interface WorkflowStreamIterator extends AsyncIterable<WorkflowEvent> {
  done: Promise<void>;
}

type WorkflowStatus = 'pending' | 'executing' | 'paused' | 'completed' | 'failed' | 'cancelled';

interface SubagentRun {
  runId: string;
  workItemId: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  completedAt?: string;
  output?: string;
  error?: string;
  promise: Promise<void>;
}

interface WorkflowState {
  id: string;
  userId: string;
  config: WorkflowConfig;
  orchestratorModel: string;
  status: WorkflowStatus;
  lastOutput?: string;
  emitter: EventEmitter;
  abortController: AbortController;
  sandboxSessionIds: string[];
  creditsConsumed: number;
  executionPromise?: Promise<void>;
  messages: ConversationMessage[];
  subagentRuns: Map<string, SubagentRun>;
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string; timestamp: string }>;
}

const workflows = new Map<string, WorkflowState>();

function readWorkflowOutputFromTrace(workflowId: string): string | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT tool_output
       FROM workflow_steps
       WHERE workflow_id = ? AND message_content = 'workflow_completed'
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .get(workflowId) as { tool_output: string | null } | undefined;

  if (!row?.tool_output) return null;

  try {
    const parsed = JSON.parse(row.tool_output) as { output?: unknown };
    return typeof parsed.output === 'string' ? parsed.output : null;
  } catch {
    return null;
  }
}

function hydrateWorkflowState(workflowId: string): WorkflowState | null {
  const existing = workflows.get(workflowId);
  if (existing) return existing;

  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, user_id, objective, orchestrator_model, status, config, credits_consumed
       FROM workflows
       WHERE id = ?`
    )
    .get(workflowId) as {
    id: string;
    user_id: string;
    objective: string;
    orchestrator_model: string | null;
    status: WorkflowStatus;
    config: string | null;
    credits_consumed: number | null;
  } | undefined;

  if (!row) return null;

  let config: WorkflowConfig = { objective: row.objective };
  if (row.config) {
    try {
      const parsed = JSON.parse(row.config) as WorkflowConfig;
      if (parsed && typeof parsed === 'object' && typeof parsed.objective === 'string') {
        config = parsed;
      }
    } catch {
      // keep fallback config
    }
  }

  const output = readWorkflowOutputFromTrace(workflowId);
  const messages: ConversationMessage[] = [{ role: 'user', content: row.objective }];
  const conversationHistory: Array<{ role: 'user' | 'assistant'; content: string; timestamp: string }> = [
    { role: 'user', content: row.objective, timestamp: new Date().toISOString() },
  ];

  if (output) {
    messages.push({ role: 'assistant', content: output });
    conversationHistory.push({ role: 'assistant', content: output, timestamp: new Date().toISOString() });
  }

  const state: WorkflowState = {
    id: row.id,
    userId: row.user_id,
    config,
    orchestratorModel: row.orchestrator_model ?? resolveOrchestratorModel(undefined),
    status: row.status,
    lastOutput: output ?? undefined,
    emitter: new EventEmitter(),
    abortController: new AbortController(),
    sandboxSessionIds: [],
    creditsConsumed: row.credits_consumed ?? 0,
    messages,
    subagentRuns: new Map(),
    conversationHistory,
  };

  state.emitter.setMaxListeners(100);
  workflows.set(workflowId, state);
  return state;
}

// Unified orchestrator tools - LLM decides which to use
const ORCHESTRATOR_TOOLS: Tool[] = [
  {
    type: 'function',
    function: {
      name: 'write_todo',
      description: 'Create a new todo item. Use this when you need to break work into discrete tasks that may run in parallel or sequence.',
      parameters: {
        type: 'object',
        properties: {
          todo_id: { type: 'string', description: 'Unique identifier for this todo' },
          description: { type: 'string', description: 'What needs to be done' },
          agent_type: { type: 'string', enum: ['research', 'analyze', 'write', 'code', 'file'], description: 'Which specialist agent should handle this' },
          depends_on: { type: 'array', items: { type: 'string' }, description: 'IDs of todos that must complete before this one can start' },
          output_artifact: { type: 'string', description: 'Expected output or deliverable name' },
        },
        required: ['todo_id', 'description', 'agent_type'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_todo',
      description: 'Update a todo item. Use this to change status (pending, running, completed, failed, skipped), add output, or modify details.',
      parameters: {
        type: 'object',
        properties: {
          todo_id: { type: 'string' },
          description: { type: 'string', description: 'New description (optional)' },
          depends_on: { type: 'array', items: { type: 'string' }, description: 'New dependencies (optional)' },
          status: { type: 'string', enum: ['pending', 'running', 'completed', 'failed', 'skipped'], description: 'New status' },
          output_artifact: { type: 'string', description: 'New expected output (optional)' },
          output: { type: 'string', description: 'The actual output/result when marking complete' },
          reason: { type: 'string', description: 'Reason for status change (especially for failed/skipped)' },
        },
        required: ['todo_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_todos',
      description: 'List current todos and optionally filter by status or agent type.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['pending', 'running', 'completed', 'failed', 'skipped'], description: 'Filter by status' },
          agent_type: { type: 'string', enum: ['research', 'analyze', 'write', 'code', 'file'], description: 'Filter by agent type' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'spawn_subagent',
      description: 'Start executing a ready todo by spawning a specialized subagent. Only works if todo status is pending and dependencies are satisfied.',
      parameters: {
        type: 'object',
        properties: {
          todo_id: { type: 'string' },
          prompt_override: { type: 'string', description: 'Optional custom prompt for the subagent' },
        },
        required: ['todo_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'await_subagents',
      description: 'Wait for running subagent tasks to complete. Use this when you need results before proceeding.',
      parameters: {
        type: 'object',
        properties: {
          todo_ids: { type: 'array', items: { type: 'string' }, description: 'Specific todos to wait for (optional, waits for all running if omitted)' },
          timeout_seconds: { type: 'number', description: 'Maximum time to wait', default: 30 },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_subagent_result',
      description: 'Fetch the latest result/output from a completed subagent todo.',
      parameters: {
        type: 'object',
        properties: {
          todo_id: { type: 'string' },
        },
        required: ['todo_id'],
      },
    },
  },
];

function emit(state: WorkflowState, event: Omit<WorkflowEvent, 'timestamp'>): void {
  const full: WorkflowEvent = {
    ...event,
    timestamp: new Date().toISOString(),
  };
  state.emitter.emit('event', full);
}

function incrementWorkflowCredits(state: WorkflowState, amount: number): void {
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

function recordStep(
  state: WorkflowState,
  step: Omit<WorkflowTraceStep, 'step_id' | 'workflow_id' | 'timestamp'> & { timestamp?: string }
): WorkflowTraceStep {
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

function buildToolTraceHooks(state: WorkflowState, subagentId: string, model?: string): ToolTraceHooks {
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
        tool_input: null,
        tool_output: event.output,
        subagent_id: event.subagent_id ?? subagentId,
      });
    },
  };
}

function extractToolCallsFromOutput(output: OutputBlock[]): ToolCall[] {
  const calls: ToolCall[] = [];

  for (const block of output) {
    if (block.type !== 'tool_use') continue;

    const name = typeof block.name === 'string' ? block.name : null;
    if (!name) continue;

    const rawArgs = block.arguments;
    let parsedArgs: Record<string, unknown> = {};

    if (typeof rawArgs === 'string') {
      try {
        parsedArgs = JSON.parse(rawArgs) as Record<string, unknown>;
      } catch {
        throw new WorkflowError(`Tool call arguments were not valid JSON for tool '${name}'.`);
      }
    } else if (rawArgs && typeof rawArgs === 'object') {
      parsedArgs = rawArgs as Record<string, unknown>;
    }

    calls.push({ name, arguments: parsedArgs });
  }

  return calls;
}

interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

function normalizeToolCall(call: ToolCall): ToolCall {
  const args = call.arguments;

  switch (call.name) {
    case 'create_work_item':
      return {
        name: 'write_todo',
        arguments: {
          ...args,
          todo_id: (args.todo_id as string | undefined) ?? (args.work_item_id as string | undefined),
        },
      };
    case 'update_work_item':
      return {
        name: 'edit_todo',
        arguments: {
          ...args,
          todo_id: (args.todo_id as string | undefined) ?? (args.work_item_id as string | undefined),
          reason: (args.reason as string | undefined) ?? (args.reason_generated as string | undefined),
        },
      };
    case 'list_work_items':
      return { name: 'list_todos', arguments: args };
    case 'spawn_subagent':
      return {
        name: 'spawn_subagent',
        arguments: {
          ...args,
          todo_id: (args.todo_id as string | undefined) ?? (args.work_item_id as string | undefined),
        },
      };
    case 'await_subagents':
      return {
        name: 'await_subagents',
        arguments: {
          ...args,
          todo_ids: (args.todo_ids as string[] | undefined) ?? (args.work_item_ids as string[] | undefined),
        },
      };
    case 'get_subagent_result':
      return {
        name: 'get_subagent_result',
        arguments: {
          ...args,
          todo_id: (args.todo_id as string | undefined) ?? (args.work_item_id as string | undefined),
        },
      };
    case 'complete_work_item':
      return {
        name: 'edit_todo',
        arguments: {
          todo_id: (args.todo_id as string | undefined) ?? (args.work_item_id as string | undefined),
          status: 'completed',
          output: args.output,
        },
      };
    case 'fail_work_item':
      return {
        name: 'edit_todo',
        arguments: {
          todo_id: (args.todo_id as string | undefined) ?? (args.work_item_id as string | undefined),
          status: 'failed',
          reason: args.error,
          output: `[failed: ${String(args.error ?? 'unknown')}]`,
        },
      };
    case 'skip_work_item':
      return {
        name: 'edit_todo',
        arguments: {
          todo_id: (args.todo_id as string | undefined) ?? (args.work_item_id as string | undefined),
          status: 'skipped',
          reason: args.reason,
          output: `[skipped: ${String(args.reason ?? 'no reason')}]`,
        },
      };
    default:
      return call;
  }
}

function tryParseLegacyEnvelope(outputText: string): { toolCalls: ToolCall[]; finalOutput?: string } | null {
  const trimmed = outputText.trim();
  const candidates: string[] = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    candidates.push(fenced[1].trim());
  }
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as {
        tool_calls?: Array<{ name?: unknown; arguments?: unknown }>;
        final_output?: unknown;
      };
      if (!Array.isArray(parsed.tool_calls)) continue;

      const toolCalls: ToolCall[] = [];
      for (const toolCall of parsed.tool_calls) {
        if (typeof toolCall?.name !== 'string') continue;
        const args = toolCall.arguments;
        toolCalls.push({
          name: toolCall.name,
          arguments: args && typeof args === 'object' ? (args as Record<string, unknown>) : {},
        });
      }

      return {
        toolCalls,
        finalOutput: typeof parsed.final_output === 'string' ? parsed.final_output : undefined,
      };
    } catch {
      // try next candidate
    }
  }

  return null;
}

async function callOrchestrator(
  state: WorkflowState,
  iteration: number
): Promise<{ toolCalls: ToolCall[]; responseText: string; rawOutput: OutputBlock[] }> {
  // Build context from current state
  const todos = listWorkItems(state.id);
  const todoContext = todos.length > 0
    ? `Current todos:\n${todos.map(t => `- ${t.id}: [${t.status}] ${t.description} (${t.agentType})${t.dependsOn.length ? ` (depends on: ${t.dependsOn.join(', ')})` : ''}`).join('\n')}`
    : 'No todos yet.';

  const instructions = loadPrompt('orchestrator.md', {
    todoContext,
    conversationHistory: formatConversationHistory(state.conversationHistory),
  });

  const response = await routeRequest({
    model: state.orchestratorModel,
    input: state.messages,
    instructions,
    tools: ORCHESTRATOR_TOOLS,
    tool_execution: 'manual',
    max_output_tokens: 4096,
    temperature: 0.2,
    trace: buildToolTraceHooks(state, 'orchestrator', state.orchestratorModel),
  });

  if (response.usage.cost.total_cost > 0) {
    try {
      debitCredits(
        state.userId,
        response.usage.cost.total_cost,
        `Orchestrator iteration ${iteration}: ${state.id}`,
        'workflow',
        state.id
      );
      incrementWorkflowCredits(state, response.usage.cost.total_cost);
    } catch {
      // Non-critical for workflow progress.
    }
  }

  recordStep(state, {
    step_type: 'orchestrator_message',
    model_name: state.orchestratorModel,
    message_content: response.output_text.substring(0, 1000),
    tool_name: null,
    tool_input: { iteration },
    tool_output: null,
    subagent_id: 'orchestrator',
  });

  let normalizedCalls: ToolCall[] = [];
  let responseText = response.output_text;

  const legacy = tryParseLegacyEnvelope(response.output_text);
  if (legacy) {
    normalizedCalls = legacy.toolCalls.map(normalizeToolCall);
    if (legacy.finalOutput && normalizedCalls.length === 0) {
      responseText = legacy.finalOutput;
    }
  } else {
    const toolCalls = extractToolCallsFromOutput(response.output);
    normalizedCalls = toolCalls.map(normalizeToolCall);
  }

  return {
    toolCalls: normalizedCalls,
    responseText,
    rawOutput: response.output,
  };
}

async function executeToolCall(
  state: WorkflowState,
  call: ToolCall
): Promise<Record<string, unknown>> {
  const normalizedCall = normalizeToolCall(call);
  const { name, arguments: args } = normalizedCall;

  switch (name) {
    case 'write_todo': {
      const existing = getWorkItem(state.id, args.todo_id as string);
      if (existing) {
        return { status: 'skipped', reason: 'todo_exists', todo_id: existing.id };
      }

      const created = createWorkItem({
        workflowId: state.id,
        itemId: args.todo_id as string,
        description: args.description as string,
        agentType: args.agent_type as AgentType,
        dependsOn: args.depends_on as string[] | undefined,
        metadata: {
          origin: 'planned',
          output_artifact: args.output_artifact as string | undefined,
        },
      });

      emit(state, {
        type: 'task_added',
        workflow_id: state.id,
        task_id: created.id,
        data: {
          description: created.description,
          agent_type: created.agentType,
          depends_on: created.dependsOn,
          origin: created.metadata.origin,
          output_artifact: created.metadata.output_artifact,
        },
      });

      return { status: 'ok', todo_id: created.id };
    }

    case 'edit_todo': {
      const existing = getWorkItem(state.id, args.todo_id as string);
      if (!existing) {
        return { status: 'error', error: 'todo_not_found', todo_id: args.todo_id };
      }

      const newStatus = args.status as WorkItemStatus | undefined;
      const output = args.output ?? (newStatus === 'failed' ? `[failed: ${args.reason ?? 'unknown'}]` : newStatus === 'skipped' ? `[skipped: ${args.reason ?? 'no reason'}]` : existing.output);

      updateWorkItem({
        workflowId: state.id,
        itemId: args.todo_id as string,
        description: args.description as string | undefined,
        dependsOn: args.depends_on as string[] | undefined,
        status: newStatus,
        output: output as string | undefined,
        metadata: {
          ...existing.metadata,
          output_artifact: (args.output_artifact as string) ?? existing.metadata.output_artifact,
          reason_generated: (args.reason as string) ?? existing.metadata.reason_generated,
        },
      });

      // Emit appropriate event
      if (newStatus === 'completed') {
        emit(state, {
          type: 'task_completed',
          workflow_id: state.id,
          task_id: existing.id,
          data: { output_preview: ((output as string) ?? '').substring(0, 500) },
        });
      } else if (newStatus === 'failed') {
        emit(state, {
          type: 'task_failed',
          workflow_id: state.id,
          task_id: existing.id,
          data: { error: (args.reason as string) ?? 'failed' },
        });
      } else if (newStatus === 'skipped') {
        emit(state, {
          type: 'task_skipped',
          workflow_id: state.id,
          task_id: existing.id,
          data: { reason: (args.reason as string) ?? 'skipped' },
        });
      }

      return { status: 'ok', todo_id: existing.id };
    }

    case 'list_todos': {
      const todos = listWorkItems(state.id);
      const filtered = todos.filter((t) => {
        if (args.status && t.status !== args.status) return false;
        if (args.agent_type && t.agentType !== args.agent_type) return false;
        return true;
      });

      return {
        status: 'ok',
        count: filtered.length,
        todos: filtered.map((t) => ({
          id: t.id,
          status: t.status,
          agent_type: t.agentType,
          depends_on: t.dependsOn,
          description: t.description,
          output: t.output,
        })),
      };
    }

    case 'spawn_subagent': {
      const item = getWorkItem(state.id, args.todo_id as string);
      if (!item) {
        return { status: 'error', error: 'todo_not_found' };
      }

      if (item.status === 'completed' || item.status === 'skipped') {
        return { status: 'skipped', reason: 'todo_already_settled', todo_id: item.id };
      }

      const todos = listWorkItems(state.id);
      const depsSatisfied = item.dependsOn.every((depId) => {
        const dep = todos.find((t) => t.id === depId);
        return dep?.status === 'completed';
      });

      if (!depsSatisfied) {
        return { status: 'blocked', reason: 'dependencies_not_satisfied', todo_id: item.id };
      }

      const run = await spawnSubagentRun(state, item, args.prompt_override as string | undefined);
      return { status: 'ok', run_id: run.runId, todo_id: run.workItemId };
    }

    case 'await_subagents': {
      const todoIds = args.todo_ids as string[] | undefined;
      const timeout = (args.timeout_seconds as number) ?? 30;

      const waited = await waitForRuns(state, todoIds, timeout);
      return { status: 'ok', ...waited };
    }

    case 'get_subagent_result': {
      const id = resolveWorkItemId(state.id, args.todo_id as string);
      const run = state.subagentRuns.get(id);
      const item = getWorkItem(state.id, id);

      if (!item) {
        return { status: 'error', error: 'todo_not_found' };
      }

      return {
        status: run?.status ?? item.status,
        todo_id: id,
        output: item.output ?? null,
        error: run?.error ?? null,
      };
    }

    case 'enter_plan_mode': {
      return { status: 'ok', mode: 'planning_requested' };
    }

    case 'plan_commit': {
      return { status: 'ok', committed: true };
    }

    case 'answer_directly': {
      return { status: 'ok', workflow_output: String(args.answer ?? '') };
    }

    case 'complete_workflow': {
      return { status: 'ok', workflow_output: String(args.output ?? '') };
    }

    default:
      return { status: 'error', error: 'unknown_tool', tool: name };
  }
}

async function spawnSubagentRun(state: WorkflowState, item: WorkItem, promptOverride?: string): Promise<SubagentRun> {
  const existingRun = state.subagentRuns.get(item.id);
  if (existingRun && existingRun.status === 'running') {
    return existingRun;
  }

  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();

  updateWorkItem({ workflowId: state.id, itemId: item.id, status: 'running' });

  recordStep(state, {
    step_type: 'subagent_spawn',
    model_name: null,
    message_content: item.description,
    tool_name: null,
    tool_input: { agent_type: item.agentType, depends_on: item.dependsOn, run_id: runId },
    tool_output: null,
    subagent_id: item.id,
  });

  emit(state, {
    type: 'task_dispatched',
    workflow_id: state.id,
    task_id: item.id,
    data: { run_id: runId, agent_type: item.agentType },
  });

  emit(state, {
    type: 'task_started',
    workflow_id: state.id,
    task_id: item.id,
    data: {
      description: item.description,
      task_type: item.agentType,
      origin: item.metadata.origin,
      output_artifact: item.metadata.output_artifact,
      run_id: runId,
    },
  });

  const prompt = promptOverride ?? buildAgentTaskPrompt(state, item, listWorkItems(state.id));
  const agentCtx = buildAgentContext(state, item.id);

  const promise = (async () => {
    try {
      const result = await dispatchToAgent(
        {
          task_id: item.id,
          description: item.description,
          agent_type: item.agentType,
          depends_on: item.dependsOn,
          status: 'running',
          origin: item.metadata.origin,
          semantic_key: item.metadata.semantic_key,
          output_artifact: item.metadata.output_artifact,
          reason_generated: item.metadata.reason_generated,
          supersedes_task_id: item.metadata.supersedes_task_id,
        },
        prompt,
        agentCtx
      );

      updateWorkItem({ workflowId: state.id, itemId: item.id, status: 'completed', output: result.output });

      const run = state.subagentRuns.get(item.id);
      if (run) {
        run.status = 'completed';
        run.completedAt = new Date().toISOString();
        run.output = result.output;
      }

      recordStep(state, {
        step_type: 'subagent_message',
        model_name: result.model,
        message_content: result.output.substring(0, 500),
        tool_name: null,
        tool_input: { run_id: runId },
        tool_output: null,
        subagent_id: item.id,
      });

      emit(state, {
        type: 'task_completed',
        workflow_id: state.id,
        task_id: item.id,
        data: {
          output_preview: result.output.substring(0, 500),
          model: result.model,
          usage: result.usage,
        },
      });
    } catch (err) {
      const errorMessage = (err as Error).message;
      updateWorkItem({ workflowId: state.id, itemId: item.id, status: 'failed', output: `[failed: ${errorMessage}]` });

      const run = state.subagentRuns.get(item.id);
      if (run) {
        run.status = 'failed';
        run.completedAt = new Date().toISOString();
        run.error = errorMessage;
      }

      recordStep(state, {
        step_type: 'system_event',
        model_name: null,
        message_content: 'task_failed',
        tool_name: null,
        tool_input: { run_id: runId },
        tool_output: { error: errorMessage },
        subagent_id: item.id,
      });

      emit(state, {
        type: 'task_failed',
        workflow_id: state.id,
        task_id: item.id,
        data: { error: errorMessage, run_id: runId },
      });
    }
  })();

  const run: SubagentRun = {
    runId,
    workItemId: item.id,
    status: 'running',
    startedAt,
    promise,
  };

  state.subagentRuns.set(item.id, run);
  return run;
}

async function waitForRuns(
  state: WorkflowState,
  todoIds?: string[],
  timeoutSeconds = 30
): Promise<{ completed: string[]; running: string[]; failed: Array<{ todo_id: string; error: string }> }> {
  const ids = todoIds ?? Array.from(state.subagentRuns.keys());
  const deadline = Date.now() + timeoutSeconds * 1000;

  const completed: string[] = [];
  const running: string[] = [];
  const failed: Array<{ todo_id: string; error: string }> = [];

  for (const id of ids) {
    const run = state.subagentRuns.get(id);
    if (!run) continue;

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      running.push(id);
      continue;
    }

    try {
      await Promise.race([
        run.promise,
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), remaining)),
      ]);

      if (run.status === 'completed') {
        completed.push(id);
      } else if (run.status === 'failed') {
        failed.push({ todo_id: id, error: run.error ?? 'Unknown error' });
      } else {
        running.push(id);
      }
    } catch {
      running.push(id);
    }
  }

  return { completed, running, failed };
}

function buildAgentTaskPrompt(state: WorkflowState, item: WorkItem, _allItems: WorkItem[]): string {
  const lines = [`Task: ${item.description}`];

  if (item.dependsOn.length > 0) {
    lines.push(`\nDependencies: ${item.dependsOn.join(', ')}`);
  }

  if (item.metadata.output_artifact) {
    lines.push(`\nExpected output: ${item.metadata.output_artifact}`);
  }

  lines.push(`\nObjective context: ${state.config.objective}`);

  return lines.join('\n');
}

function buildAgentContext(state: WorkflowState, taskId: string): AgentExecutionContext {
  return {
    workflowId: state.id,
    userId: state.userId,
    orchestratorModel: state.orchestratorModel,
    config: state.config,
    sandboxSessionIds: state.sandboxSessionIds,
    creditsCallback: (amount: number, description: string) => {
      try {
        debitCredits(state.userId, amount, description, 'subagent', state.id);
        incrementWorkflowCredits(state, amount);
      } catch {
        // Non-critical
      }
    },
    trace: buildToolTraceHooks(state, taskId),
  };
}

function completeWorkflow(state: WorkflowState, output: string): void {
  state.status = 'completed';
  state.lastOutput = output;

  const db = getDb();
  db.prepare(
    `UPDATE workflows SET status = 'completed', ended_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
  ).run(state.id);

  recordStep(state, {
    step_type: 'system_event',
    model_name: state.orchestratorModel,
    message_content: 'workflow_completed',
    tool_name: null,
    tool_input: null,
    tool_output: { output: output.substring(0, 1000), total_credits: state.creditsConsumed },
    subagent_id: 'orchestrator',
  });

  emit(state, {
    type: 'workflow_completed',
    workflow_id: state.id,
    data: { output, total_credits: state.creditsConsumed },
  });

  cleanupSessions(state);
}

async function failWorkflow(state: WorkflowState, message: string): Promise<void> {
  state.status = 'failed';

  const db = getDb();
  db.prepare(
    `UPDATE workflows SET status = 'failed', ended_at = datetime('now'), error = ? WHERE id = ?`
  ).run(message, state.id);

  emit(state, {
    type: 'workflow_failed',
    workflow_id: state.id,
    data: { error: message },
  });

  cleanupSessions(state);
}

function cleanupSessions(state: WorkflowState): void {
  for (const sessionId of state.sandboxSessionIds) {
    try {
      terminateSession(sessionId);
    } catch {
      // Best effort cleanup
    }
  }
  state.sandboxSessionIds.length = 0;
}

// ============================================================================
// MAIN AGENTIC LOOP
// ============================================================================

export async function runWorkflow(
  userId: string,
  config: WorkflowConfig,
  workflowId?: string
): Promise<{ workflowId: string; output: string; status: WorkflowStatus }> {
  const isContinuing = !!workflowId && workflows.has(workflowId);
  const id = workflowId ?? crypto.randomUUID();
  const orchestratorModel = resolveOrchestratorModel(config.orchestrator_model ?? config.model_overrides?.orchestrator);

  let state: WorkflowState;

  if (isContinuing) {
    // Continue an in-memory workflow run
    state = workflows.get(id)!;
    state.abortController = new AbortController();

    if (state.status !== 'executing') {
      throw new WorkflowError(`Cannot run workflow in status: ${state.status}`);
    }
  } else {
    // Start new workflow
    const db = getDb();
    db.prepare(
      `INSERT INTO workflows (id, user_id, objective, user_prompt, orchestrator_model, status, config, started_at)
       VALUES (?, ?, ?, ?, ?, 'executing', ?, datetime('now'))`
    ).run(id, userId, config.objective, config.objective, orchestratorModel, JSON.stringify(config));

    state = {
      id,
      userId,
      config,
      orchestratorModel,
      status: 'executing',
      emitter: new EventEmitter(),
      abortController: new AbortController(),
      sandboxSessionIds: [],
      creditsConsumed: 0,
      messages: [{ role: 'user', content: config.objective }],
      subagentRuns: new Map(),
      conversationHistory: [{ role: 'user', content: config.objective, timestamp: new Date().toISOString() }],
    };

    state.emitter.setMaxListeners(100);
    workflows.set(id, state);
  }

  try {
    for (let iteration = 1; iteration <= MAX_TURNS; iteration++) {
      if (state.abortController.signal.aborted) {
        throw new WorkflowError('Workflow cancelled');
      }

      // Call LLM - it decides what to do
      const { toolCalls, responseText } = await callOrchestrator(state, iteration);

      // Add assistant response to history
      state.messages.push({ role: 'assistant', content: responseText });
      state.conversationHistory.push({
        role: 'assistant',
        content: responseText,
        timestamp: new Date().toISOString(),
      });

      // If no tool calls, workflow is complete
      if (toolCalls.length === 0) {
        completeWorkflow(state, responseText);
        return { workflowId: id, output: responseText, status: 'completed' };
      }

      // Execute tool calls
      const toolResults: Array<Record<string, unknown>> = [];
      let explicitOutput: string | null = null;
      for (const call of toolCalls) {
        const result = await executeToolCall(state, call);
        toolResults.push({ tool: call.name, ...result });

        if (typeof result.workflow_output === 'string' && result.workflow_output.length > 0) {
          explicitOutput = result.workflow_output;
        }
      }

      if (explicitOutput) {
        completeWorkflow(state, explicitOutput);
        return { workflowId: id, output: explicitOutput, status: 'completed' };
      }

      // Add tool results to conversation
      const resultsMessage = `Tool results:\n${toolResults.map(r => `- ${r.tool}: ${JSON.stringify(r)}`).join('\n')}`;
      state.messages.push({ role: 'user', content: resultsMessage });
    }

    // Exceeded max turns
    await failWorkflow(state, `Workflow exceeded ${MAX_TURNS} turns`);
    return { workflowId: id, output: 'Workflow exceeded maximum turns', status: 'failed' };

  } catch (err) {
    const errorMessage = (err as Error).message;
    await failWorkflow(state, errorMessage);
    throw err;
  }
}

// ============================================================================
// LEGACY API COMPATIBILITY
// ============================================================================

export async function planWorkflow(
  userId: string,
  config: WorkflowConfig
): Promise<{ workflowId: string; tasks: OrchestratorTask[] }> {
  const workflowId = crypto.randomUUID();
  const orchestratorModel = resolveOrchestratorModel(config.orchestrator_model ?? config.model_overrides?.orchestrator);

  const db = getDb();
  db.prepare(
    `INSERT INTO workflows (id, user_id, objective, user_prompt, orchestrator_model, status, config, started_at)
     VALUES (?, ?, ?, ?, ?, 'executing', ?, datetime('now'))`
  ).run(workflowId, userId, config.objective, config.objective, orchestratorModel, JSON.stringify(config));

  const state: WorkflowState = {
    id: workflowId,
    userId,
    config,
    orchestratorModel,
    status: 'executing',
    emitter: new EventEmitter(),
    abortController: new AbortController(),
    sandboxSessionIds: [],
    creditsConsumed: 0,
    messages: [{ role: 'user', content: config.objective }],
    subagentRuns: new Map(),
    conversationHistory: [{ role: 'user', content: config.objective, timestamp: new Date().toISOString() }],
  };

  state.emitter.setMaxListeners(100);
  workflows.set(workflowId, state);

  recordStep(state, {
    step_type: 'orchestrator_message',
    model_name: orchestratorModel,
    message_content: `Workflow created: ${config.objective}`,
    tool_name: null,
    tool_input: null,
    tool_output: null,
    subagent_id: 'orchestrator',
  });

  const todos = listWorkItems(workflowId);

  return {
    workflowId,
    tasks: todos.map(toPublicTask),
  };
}

export function executeWorkflow(workflowId: string): WorkflowStreamIterator {
  const state = hydrateWorkflowState(workflowId);
  if (!state) {
    throw new WorkflowError(`Workflow not found: ${workflowId}`);
  }

  if (!state.executionPromise && state.status !== 'executing') {
    const terminalEvents: WorkflowEvent[] = [];
    if (state.status === 'completed') {
      terminalEvents.push({
        type: 'workflow_completed',
        workflow_id: workflowId,
        data: { output: state.lastOutput ?? '', total_credits: state.creditsConsumed },
        timestamp: new Date().toISOString(),
      });
    } else if (state.status === 'failed' || state.status === 'cancelled') {
      terminalEvents.push({
        type: 'workflow_failed',
        workflow_id: workflowId,
        data: { error: state.status === 'cancelled' ? 'Workflow cancelled' : 'Workflow failed' },
        timestamp: new Date().toISOString(),
      });
    }

    const iterator: AsyncIterable<WorkflowEvent> = {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<WorkflowEvent>> {
            if (terminalEvents.length > 0) {
              return Promise.resolve({ value: terminalEvents.shift()!, done: false });
            }
            return Promise.resolve({ value: undefined as never, done: true });
          },
        };
      },
    };

    return {
      ...iterator,
      done: Promise.resolve(),
    };
  }

  const eventQueue: WorkflowEvent[] = [];
  let resolveWaiter: (() => void) | null = null;
  let streamDone = false;

  const listener = (event: WorkflowEvent) => {
    eventQueue.push(event);
    if (resolveWaiter) {
      resolveWaiter();
      resolveWaiter = null;
    }
  };

  state.emitter.on('event', listener);

  const runPromise = (state.executionPromise ??= runWorkflow(state.userId, state.config, workflowId)
    .then((result) => {
      state.lastOutput = result.output;
    })
    .finally(() => {
      state.executionPromise = undefined;
      streamDone = true;
      if (resolveWaiter) {
        resolveWaiter();
        resolveWaiter = null;
      }
    }));

  const iterator: AsyncIterable<WorkflowEvent> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<WorkflowEvent>> {
          while (eventQueue.length === 0 && !streamDone) {
            await new Promise<void>((resolve) => {
              resolveWaiter = resolve;
            });
          }

          if (eventQueue.length > 0) {
            const value = eventQueue.shift()!;
            return { value, done: false };
          }

          state.emitter.off('event', listener);
          return { value: undefined as never, done: true };
        },
      };
    },
  };

  return {
    ...iterator,
    done: runPromise.then(() => undefined),
  };
}

export function executeWorkflowToCompletion(workflowId: string): Promise<void> {
  const stream = executeWorkflow(workflowId);
  return stream.done;
}

function toPublicTask(item: WorkItem): OrchestratorTask {
  return {
    task_id: item.id,
    description: item.description,
    agent_type: item.agentType,
    depends_on: item.dependsOn,
    status: item.status,
    origin: item.metadata.origin,
    semantic_key: item.metadata.semantic_key,
    output_artifact: item.metadata.output_artifact,
    reason_generated: item.metadata.reason_generated,
    supersedes_task_id: item.metadata.supersedes_task_id,
  };
}

// ============================================================================
// WORKFLOW CONTROL FUNCTIONS
// ============================================================================

export function cancelWorkflow(workflowId: string): void {
  const state = hydrateWorkflowState(workflowId);
  if (!state) {
    throw new WorkflowError(`Workflow not found: ${workflowId}`);
  }

  state.abortController.abort();
  state.status = 'cancelled';

  const db = getDb();
  db.prepare(
    "UPDATE workflows SET status = 'cancelled', ended_at = datetime('now') WHERE id = ?"
  ).run(workflowId);

  db.prepare(
    "UPDATE tasks SET status = 'cancelled', completed_at = datetime('now') WHERE workflow_id = ? AND status IN ('pending', 'running')"
  ).run(workflowId);

  cleanupSessions(state);

  emit(state, {
    type: 'workflow_failed',
    workflow_id: workflowId,
    data: { error: 'Workflow cancelled by user' },
  });
}

export function getWorkflowState(workflowId: string): WorkflowState | null {
  return hydrateWorkflowState(workflowId);
}

export function getWorkflowEmitter(workflowId: string): EventEmitter | null {
  return hydrateWorkflowState(workflowId)?.emitter ?? null;
}

export interface WorkflowSummary {
  id: string;
  objective: string;
  user_prompt?: string;
  orchestrator_model?: string | null;
  status: string;
  credits_consumed: number;
  started_at?: string | null;
  ended_at?: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  output?: string | null;
}

export interface TaskSummary {
  task_id: string;
  description: string;
  agent_type: string;
  depends_on: string[];
  status: string;
  output?: string;
  created_at: string;
  completed_at?: string | null;
}

export function getWorkflowDetails(workflowId: string): { workflow: WorkflowSummary; tasks: TaskSummary[] } | null {
  const db = getDb();
  const workflow = db
    .prepare(
      `SELECT id, objective, user_prompt, orchestrator_model, status,
              credits_consumed, started_at, ended_at, created_at, updated_at, completed_at
       FROM workflows WHERE id = ?`
    )
    .get(workflowId) as WorkflowSummary | undefined;

  if (!workflow) return null;

  const inMemoryState = workflows.get(workflowId);
  if (inMemoryState?.lastOutput) {
    workflow.output = inMemoryState.lastOutput;
  }

  const taskRows = db
    .prepare(
      `SELECT
          id AS task_id,
          description,
          task_type AS agent_type,
          parent_task_ids,
          status,
          output,
          created_at,
          completed_at
       FROM tasks
       WHERE workflow_id = ?
       ORDER BY created_at`
    )
    .all(workflowId) as Array<{
      task_id: string;
      description: string | null;
      agent_type: string;
      parent_task_ids: string | null;
      status: string;
      output: string | null;
      created_at: string;
      completed_at: string | null;
    }>;

  const tasks: TaskSummary[] = taskRows.map((row) => {
    let dependsOn: string[] = [];
    try {
      dependsOn = JSON.parse(row.parent_task_ids ?? '[]') as string[];
    } catch {
      dependsOn = [];
    }

    return {
      task_id: row.task_id,
      description: row.description ?? '',
      agent_type: row.agent_type,
      depends_on: dependsOn,
      status: row.status,
      output: row.output ?? undefined,
      created_at: row.created_at,
      completed_at: row.completed_at,
    };
  });

  return { workflow, tasks };
}

export function listWorkflows(userId: string): WorkflowSummary[] {
  const db = getDb();
  const workflowsFromDb = db
    .prepare(
      `SELECT id, objective, user_prompt, orchestrator_model, status,
              credits_consumed, started_at, ended_at, created_at, updated_at, completed_at
       FROM workflows WHERE user_id = ? ORDER BY created_at DESC`
    )
    .all(userId) as WorkflowSummary[];

  return workflowsFromDb.map((workflow) => {
    const inMemory = workflows.get(workflow.id);
    return inMemory?.lastOutput ? { ...workflow, output: inMemory.lastOutput } : workflow;
  });
}

export function getWorkflowTrace(workflowId: string): WorkflowTraceStep[] {
  return readWorkflowTrace(workflowId);
}

export async function continueWorkflow(
  workflowId: string,
  followUpQuery: string
): Promise<{ workflowId: string; status: WorkflowStatus }> {
  const state = hydrateWorkflowState(workflowId);
  if (!state) {
    throw new WorkflowError(`Workflow not found: ${workflowId}`);
  }

  state.config = {
    ...state.config,
    objective: followUpQuery,
  };
  state.status = 'executing';
  state.abortController = new AbortController();

  state.messages.push({ role: 'user', content: followUpQuery });
  state.conversationHistory.push({
    role: 'user',
    content: followUpQuery,
    timestamp: new Date().toISOString(),
  });

  const db = getDb();
  db.prepare(`UPDATE workflows SET status = 'executing', objective = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(followUpQuery, workflowId);

  state.executionPromise = undefined;
  return { workflowId, status: 'executing' };
}

export function getWorkflowSummaryById(
  workflowId: string
): { workflowId: string; status: WorkflowStatus; output?: string | null } | null {
  const state = hydrateWorkflowState(workflowId);
  if (state) {
    return {
      workflowId,
      status: state.status,
      output: state.lastOutput ?? null,
    };
  }

  const db = getDb();
  const row = db
    .prepare(`SELECT id, status FROM workflows WHERE id = ?`)
    .get(workflowId) as { id: string; status: WorkflowStatus } | undefined;

  if (!row) return null;

  return {
    workflowId: row.id,
    status: row.status,
    output: null,
  };
}

export function pauseWorkflow(workflowId: string): void {
  const state = hydrateWorkflowState(workflowId);
  if (!state) {
    throw new WorkflowError(`Workflow not found: ${workflowId}`);
  }
  if (state.status !== 'executing') {
    throw new WorkflowError(`Cannot pause workflow in status: ${state.status}`);
  }

  state.status = 'paused';
  const db = getDb();
  db.prepare(`UPDATE workflows SET status = 'paused', updated_at = datetime('now') WHERE id = ?`).run(workflowId);
}

export async function resumeWorkflow(
  workflowId: string,
  _approvals?: Array<{ task_id: string; approved: boolean; feedback?: string }>
): Promise<void> {
  const state = hydrateWorkflowState(workflowId);
  if (!state) {
    throw new WorkflowError(`Workflow not found: ${workflowId}`);
  }
  if (state.status !== 'paused' && state.status !== 'completed' && state.status !== 'failed') {
    throw new WorkflowError(`Cannot resume workflow in status: ${state.status}`);
  }

  state.status = 'executing';
  state.abortController = new AbortController();
  const db = getDb();
  db.prepare(`UPDATE workflows SET status = 'executing', updated_at = datetime('now') WHERE id = ?`).run(workflowId);

  if (!state.executionPromise) {
    state.executionPromise = runWorkflow(state.userId, state.config, workflowId)
      .then((result) => {
        state.lastOutput = result.output;
      })
      .finally(() => {
        state.executionPromise = undefined;
      });
  }
}
