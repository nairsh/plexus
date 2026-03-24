import type { AgentType } from '@orchestrator/shared';
import {
  createWorkItem,
  getWorkItem,
  getWorkItemDisplayId,
  listWorkItems,
  resolveWorkItemId,
  updateWorkItem,
  type WorkItemStatus,
} from '../workItems.js';
import { emitWorkflowEvent } from '../workflow/emitter.js';
import type { WorkflowState } from '../workflow/state.js';
import { areDependenciesSatisfied, spawnSubagentRun, waitForRuns } from '../subagents/runner.js';
import type { ToolCall } from './tools.js';
import { executeToolCall, getOpenTerminalSessionForChat, getSkillByIdForUser } from '@orchestrator/model-router';
import { saveMemory } from '@orchestrator/memory';
import { createSession } from '@orchestrator/sandbox';
import { buildToolTraceHooks, recordStep } from './tracing.js';
import { buildDisplayDescription } from './displayLabel.js';
import { normalizeWorkingDirectory } from '../folderScope.js';

const BUILTIN_ORCHESTRATOR_TOOLS = new Set([
  'web_search',
  'fetch_url',
  'bash',
  'file_read',
  'file_write',
  'file_edit',
  'grep',
  'glob',
]);
const WORKSPACE_ORCHESTRATOR_TOOLS = new Set(['bash', 'file_read', 'file_write', 'file_edit', 'grep', 'glob']);

const toDisplayTodoId = (state: WorkflowState, todoId: string): string => {
  return getWorkItemDisplayId(state.id, resolveWorkItemId(state.id, todoId));
};

const buildToolDisplayInput = (
  state: WorkflowState,
  name: string,
  args: Record<string, unknown>
): Record<string, unknown> => {
  switch (name) {
    case 'write_todo':
      return {
        ...args,
        todo_id: typeof args.todo_id === 'string' ? toDisplayTodoId(state, args.todo_id) : args.todo_id,
      };
    case 'edit_todo': {
      const item = typeof args.todo_id === 'string' ? getWorkItem(state.id, args.todo_id) : null;
      return {
        ...args,
        todo_id: typeof args.todo_id === 'string' ? toDisplayTodoId(state, args.todo_id) : args.todo_id,
        description: typeof args.description === 'string' ? args.description : item?.description,
      };
    }
    case 'spawn_subagent': {
      const item = typeof args.todo_id === 'string' ? getWorkItem(state.id, args.todo_id) : null;
      return {
        todo_id: typeof args.todo_id === 'string' ? toDisplayTodoId(state, args.todo_id) : args.todo_id,
        description: typeof args.description === 'string' ? args.description : item?.description,
      };
    }
    case 'await_subagents':
      return {
        ...args,
        todo_ids: Array.isArray(args.todo_ids)
          ? args.todo_ids.map((todoId) =>
              typeof todoId === 'string' ? toDisplayTodoId(state, todoId) : String(todoId)
            )
          : args.todo_ids,
      };
    default:
      return args;
  }
};

const buildToolDisplayResult = (
  state: WorkflowState,
  name: string,
  result: Record<string, unknown>
): Record<string, unknown> => {
  switch (name) {
    case 'write_todo':
    case 'edit_todo':
    case 'spawn_subagent': {
      const todoId = typeof result.todo_id === 'string' ? result.todo_id : undefined;
      const item = todoId ? getWorkItem(state.id, todoId) : null;
      return {
        ...result,
        display_todo_id: todoId ? toDisplayTodoId(state, todoId) : undefined,
        description: item?.description,
      };
    }
    case 'list_todos': {
      const todos = Array.isArray(result.todos) ? result.todos : [];
      return {
        ...result,
        todos: todos.map((todo) => {
          if (!todo || typeof todo !== 'object') return todo;
          const record = todo as Record<string, unknown>;
          const todoId = typeof record.id === 'string' ? record.id : '';
          return {
            ...record,
            id: todoId ? toDisplayTodoId(state, todoId) : record.id,
            depends_on: Array.isArray(record.depends_on)
              ? record.depends_on.map((depId) =>
                  typeof depId === 'string' ? toDisplayTodoId(state, depId) : String(depId)
                )
              : record.depends_on,
          };
        }),
      };
    }
    case 'await_subagents': {
      const completedResults = Array.isArray(result.completed_results)
        ? result.completed_results.map((entry) => {
            if (!entry || typeof entry !== 'object') return entry;
            const record = entry as Record<string, unknown>;
            const todoId = typeof record.todo_id === 'string' ? record.todo_id : '';
            return {
              ...record,
              display_todo_id: todoId ? toDisplayTodoId(state, todoId) : record.display_todo_id,
            };
          })
        : result.completed_results;
      return {
        ...result,
        completed: Array.isArray(result.completed)
          ? result.completed.map((todoId) =>
              typeof todoId === 'string' ? toDisplayTodoId(state, todoId) : String(todoId)
            )
          : result.completed,
        running: Array.isArray(result.running)
          ? result.running.map((todoId) =>
              typeof todoId === 'string' ? toDisplayTodoId(state, todoId) : String(todoId)
            )
          : result.running,
        failed: Array.isArray(result.failed)
          ? result.failed.map((entry) => {
              if (!entry || typeof entry !== 'object') return entry;
              const record = entry as Record<string, unknown>;
              const todoId = typeof record.todo_id === 'string' ? record.todo_id : '';
              return {
                ...record,
                display_todo_id: todoId ? toDisplayTodoId(state, todoId) : record.display_todo_id,
              };
            })
          : result.failed,
        completed_results: completedResults,
      };
    }
    default:
      return result;
  }
};

const ensureWorkflowWorkspaceSession = async (state: WorkflowState): Promise<void> => {
  const chatId = state.config.chat_id ?? state.id;
  const workingDirectory = normalizeWorkingDirectory(state.config.working_directory);
  const existing = await getOpenTerminalSessionForChat(state.userId, chatId);
  const matchesRequestedWorkingDirectory = workingDirectory ? existing?.workingDirectory === workingDirectory : Boolean(existing);
  if (matchesRequestedWorkingDirectory) return;

  const session = await createSession(state.userId, {
    language: 'javascript',
    chat_id: chatId,
    ...(workingDirectory ? { working_directory: workingDirectory } : {}),
  });
  state.sandboxSessionIds.push(session.id);
};

export const executeOrchestratorToolCall = async (
  state: WorkflowState,
  call: ToolCall
): Promise<Record<string, unknown>> => {
  const { name, arguments: args } = call;
  const isBuiltinOrchestratorTool = BUILTIN_ORCHESTRATOR_TOOLS.has(name);

  const emitToolCall = (toolInput: Record<string, unknown>) => {
    // Built-in tools emit tool events and trace via model-router hooks.
    if (!isBuiltinOrchestratorTool) {
      emitWorkflowEvent(state, {
        type: 'tool_call',
        workflow_id: state.id,
        data: { tool_name: name, tool_input: toolInput },
      });

      recordStep(state, {
        step_type: 'tool_call',
        model_name: state.orchestratorModel,
        message_content: null,
        tool_name: name,
        tool_input: toolInput,
        tool_output: null,
        subagent_id: 'orchestrator',
      });
    }
  };

  const finish = (result: Record<string, unknown>): Record<string, unknown> => {
    const displayResult = buildToolDisplayResult(state, name, result);
    // Built-in tools emit tool events and trace via model-router hooks.
    if (!isBuiltinOrchestratorTool) {
      emitWorkflowEvent(state, {
        type: 'tool_result',
        workflow_id: state.id,
        data: { tool_name: name, tool_output: displayResult },
      });

      recordStep(state, {
        step_type: 'tool_result',
        model_name: state.orchestratorModel,
        message_content: null,
        tool_name: name,
        tool_input: null,
        tool_output: displayResult,
        subagent_id: 'orchestrator',
      });
    }

    return displayResult;
  };

  if (isBuiltinOrchestratorTool) {
    const chatId = state.config.chat_id ?? state.id;
    if (WORKSPACE_ORCHESTRATOR_TOOLS.has(name)) {
      await ensureWorkflowWorkspaceSession(state);
    }
    emitToolCall(buildToolDisplayInput(state, name, args));

    const toolBlocks: import('@orchestrator/shared').OutputBlock[] = [];
    const result = await executeToolCall(
      name,
      args,
      {
        model: state.orchestratorModel,
        input: state.messages,
        instructions: '',
        tools: [
          {
            type: name as
              | 'web_search'
              | 'fetch_url'
              | 'bash'
              | 'file_read'
              | 'file_write'
              | 'file_edit'
              | 'grep'
              | 'glob',
          },
        ],
        chat_id: chatId,
        user_id: state.userId,
        working_directory: normalizeWorkingDirectory(state.config.working_directory),
        signal: state.abortController.signal,
        trace: buildToolTraceHooks(state, 'orchestrator', state.orchestratorModel),
      },
      toolBlocks
    );

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(result.output) as Record<string, unknown>;
    } catch {
      parsed = { output: result.output };
    }

    return finish(parsed);
  }

  emitToolCall(buildToolDisplayInput(state, name, args));

  switch (name) {
    case 'write_todo': {
      const existing = getWorkItem(state.id, args.todo_id as string);
      if (existing) {
        return finish({
          status: 'skipped',
          reason: 'todo_exists',
          todo_id: existing.id,
          description: existing.description,
        });
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

      emitWorkflowEvent(state, {
        type: 'task_added',
        workflow_id: state.id,
        task_id: created.id,
        data: {
          description: created.description,
          display_description: buildDisplayDescription(created.description, created.agentType),
          agent_type: created.agentType,
          depends_on: created.dependsOn,
          origin: created.metadata.origin,
          output_artifact: created.metadata.output_artifact,
        },
      });

      return finish({ status: 'ok', todo_id: created.id, description: created.description });
    }

    case 'edit_todo': {
      const existing = getWorkItem(state.id, args.todo_id as string);
      if (!existing) {
        return finish({ status: 'error', error: 'todo_not_found', todo_id: args.todo_id });
      }

      const VALID_STATUSES = new Set<WorkItemStatus>(['pending', 'running', 'completed', 'failed', 'blocked', 'cancelled', 'skipped']);
      const rawStatus = args.status as string | undefined;
      const newStatus = rawStatus && VALID_STATUSES.has(rawStatus as WorkItemStatus)
        ? rawStatus as WorkItemStatus
        : undefined;
      const output =
        args.output ??
        (newStatus === 'failed'
          ? `[failed: ${args.reason ?? 'unknown'}]`
          : newStatus === 'skipped'
            ? `[skipped: ${args.reason ?? 'no reason'}]`
            : existing.output);

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

      if (newStatus === 'completed') {
        emitWorkflowEvent(state, {
          type: 'task_completed',
          workflow_id: state.id,
          task_id: existing.id,
          data: { output_preview: ((output as string) ?? '').substring(0, 2000) },
        });
      } else if (newStatus === 'failed') {
        emitWorkflowEvent(state, {
          type: 'task_failed',
          workflow_id: state.id,
          task_id: existing.id,
          data: { error: (args.reason as string) ?? 'failed' },
        });
      } else if (newStatus === 'skipped') {
        emitWorkflowEvent(state, {
          type: 'task_skipped',
          workflow_id: state.id,
          task_id: existing.id,
          data: { reason: (args.reason as string) ?? 'skipped' },
        });
      }

      return finish({ status: 'ok', todo_id: existing.id, description: existing.description });
    }

    case 'list_todos': {
      const todos = listWorkItems(state.id);
      const filtered = todos.filter((todo) => {
        if (args.status && todo.status !== args.status) return false;
        if (args.agent_type && todo.agentType !== args.agent_type) return false;
        return true;
      });

      return finish({
        status: 'ok',
        count: filtered.length,
        todos: filtered.map((todo) => ({
          id: todo.id,
          status: todo.status,
          agent_type: todo.agentType,
          depends_on: todo.dependsOn,
          description: todo.description,
          output: todo.output,
        })),
      });
    }

    case 'spawn_subagent': {
      const item = getWorkItem(state.id, args.todo_id as string);
      if (!item) {
        return finish({ status: 'error', error: 'todo_not_found' });
      }

      if (item.status === 'completed' || item.status === 'skipped') {
        return finish({
          status: 'skipped',
          reason: 'todo_already_settled',
          todo_id: item.id,
          description: item.description,
        });
      }

      if (!areDependenciesSatisfied(state, item)) {
        return finish({
          status: 'blocked',
          reason: 'dependencies_not_satisfied',
          todo_id: item.id,
          description: item.description,
        });
      }

      const run = await spawnSubagentRun(
        state,
        item,
        args.prompt_override as string | undefined,
        typeof args.description === 'string' && args.description.trim().length > 0 ? args.description.trim() : undefined
      );
      return finish({ status: 'ok', run_id: run.runId, todo_id: run.workItemId, description: item.description });
    }

    case 'await_subagents': {
      const waited = await waitForRuns(
        state,
        args.todo_ids as string[] | undefined,
        (args.timeout_seconds as number) ?? 30
      );
      return finish({ status: 'ok', ...waited });
    }

    case 'write_memory': {
      const content = args.content as string;
      const category = typeof args.category === 'string' ? args.category : 'general';
      if (!content?.trim()) {
        return finish({ status: 'error', error: 'content is required' });
      }
      // Use a hash of the content as the key to allow multiple distinct memories
      const key = `memory_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const memory = saveMemory(state.userId, { content: content.trim(), category, key });
      return finish({ status: 'ok', memory_id: memory.id, content: memory.content });
    }

    case 'enter_plan_mode':
      return finish({ status: 'ok', mode: 'planning_requested' });

    case 'plan_commit':
      return finish({ status: 'ok', committed: true });

    case 'answer_directly':
      return finish({ status: 'ok', workflow_output: String(args.answer ?? '') });

    case 'complete_workflow':
      return finish({ status: 'ok', workflow_output: String(args.output ?? '') });

    case 'run_skill': {
      const skillId = args.skill_id as string;

      if (!skillId) {
        return finish({ status: 'error', error: 'missing_skill_id' });
      }

      const skill = getSkillByIdForUser(state.userId, skillId);
      if (!skill) {
        return finish({ status: 'error', error: 'skill_not_found', skill_id: skillId });
      }

      return finish({
        status: 'ok',
        skill_activated: skillId,
        skill_name: skill.name,
        instructions: skill.prompt_addendum ?? null,
      });
    }

    default:
      return finish({ status: 'error', error: 'unknown_tool', tool: name });
  }
};
