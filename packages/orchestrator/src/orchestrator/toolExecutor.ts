import type { AgentType } from '@orchestrator/shared';
import { getDb, logger } from '@orchestrator/shared';
import {
  createWorkItem,
  getWorkItem,
  getWorkItemDisplayId,
  isWorkItemDependencySatisfied,
  listWorkItems,
  resolveWorkItemId,
  updateWorkItem,
  type WorkItemStatus,
} from '../workItems.js';
import { validateWorkItemGraph, formatGraphErrors } from '../validateWorkItemGraph.js';
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
import { verifyOutput } from '../outputVerifier.js';
import { randomUUID } from 'crypto';

const BUILTIN_ORCHESTRATOR_TOOLS = new Set([
  'web_search',
  'fetch_url',
  'bash',
  'file_read',
  'file_write',
  'file_edit',
  'grep',
  'glob',
  'search_knowledge',
  'github_api',
  'linear_api',
  'notion_api',
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
    case 'create_team':
      return {
        team_name: args.team_name,
        purpose: args.purpose,
        roles: Array.isArray(args.roles) ? (args.roles as Array<{name: string}>).map(r => r.name).join(', ') : args.roles,
      };
    case 'message_teammate':
      return {
        team_name: args.team_name,
        to: args.to,
        message: typeof args.message === 'string' ? args.message.slice(0, 200) : args.message,
        priority: args.priority,
      };
    case 'check_team_status':
      return { team_name: args.team_name };
    case 'dissolve_team':
      return { team_name: args.team_name, summary: args.summary };
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
              | 'glob'
              | 'search_knowledge',
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
      const todoId = args.todo_id as string;
      const dependsOnRaw = args.depends_on as string[] | undefined;

      const existing = getWorkItem(state.id, todoId);
      if (existing) {
        return finish({
          status: 'skipped',
          reason: 'todo_exists',
          todo_id: existing.id,
          description: existing.description,
        });
      }

      // Reject self-dependency before persisting — return error so the LLM
      // can self-correct rather than crashing the workflow.
      if (dependsOnRaw?.some((depId) => depId === todoId)) {
        return finish({
          status: 'error',
          error: 'self_dependency',
          message: `Task '${todoId}' cannot depend on itself. Remove it from depends_on.`,
          todo_id: todoId,
        });
      }

      const created = createWorkItem({
        workflowId: state.id,
        itemId: todoId,
        description: args.description as string,
        agentType: args.agent_type as AgentType,
        dependsOn: dependsOnRaw,
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

      // Validate dependencies explicitly: distinguish dangling (structural
      // error) from unsatisfied (normal blocked state).
      if (item.dependsOn.length > 0) {
        const allItems = listWorkItems(state.id);
        const byId = new Map(allItems.map((i) => [i.id, i] as const));

        const dangling = item.dependsOn.filter((depId) => !byId.has(depId));
        if (dangling.length > 0) {
          const displayDangling = dangling.map((d) => getWorkItemDisplayId(state.id, d));
          return finish({
            status: 'error',
            error: 'dangling_dependency',
            message: `Task '${getWorkItemDisplayId(state.id, item.id)}' depends on non-existent tasks: ${displayDangling.join(', ')}. Create these tasks first or remove the dependency.`,
            todo_id: item.id,
          });
        }

        const unsatisfied = item.dependsOn.some((depId) => {
          const dep = byId.get(depId)!;
          return !isWorkItemDependencySatisfied(dep.status);
        });
        if (unsatisfied) {
          return finish({
            status: 'blocked',
            reason: 'dependencies_not_satisfied',
            todo_id: item.id,
            description: item.description,
          });
        }
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

    case 'answer_directly': {
      const answerRaw = String(args.answer ?? '');
      const answerCheck = verifyOutput(answerRaw);
      if (!answerCheck.valid) {
        return finish({ status: 'error', error: `Invalid output: ${answerCheck.reason}` });
      }
      return finish({ status: 'ok', workflow_output: answerRaw });
    }

    case 'complete_workflow': {
      const outputRaw = String(args.output ?? '');
      const outputCheck = verifyOutput(outputRaw);
      if (!outputCheck.valid) {
        return finish({ status: 'error', error: `Invalid output: ${outputCheck.reason}` });
      }
      return finish({ status: 'ok', workflow_output: outputRaw });
    }

    case 'request_clarification': {
      const question = args.question as string;
      if (!question?.trim()) {
        return finish({ status: 'error', error: 'question is required' });
      }
      
      // Validate options
      const options = Array.isArray(args.options)
        ? (args.options as Array<{ label: string; description?: string }>)
        : undefined;
        
      if (!options || options.length < 2) {
        return finish({ 
          status: 'error', 
          error: 'At least 2 options are required. Provide 2-3 predefined options for the user to choose from.' 
        });
      }
      
      if (options.length > 3) {
        return finish({ 
          status: 'error', 
          error: 'Maximum 3 options allowed. Please limit to 2-3 predefined options.' 
        });
      }
      
      // Validate each option has a label
      for (const opt of options) {
        if (!opt.label || typeof opt.label !== 'string' || !opt.label.trim()) {
          return finish({ 
            status: 'error', 
            error: 'All options must have a non-empty label.' 
          });
        }
      }
      
      const allowCustom = args.allow_custom !== false;

      emitWorkflowEvent(state, {
        type: 'clarification_requested',
        workflow_id: state.id,
        data: { question: question.trim(), options, allow_custom: allowCustom },
      });
      return finish({
        status: 'ok',
        clarification_question: question.trim(),
        options,
        allow_custom: allowCustom,
        pause_workflow: true,
      });
    }

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

    case 'create_team': {
      const teamName = args.team_name as string;
      const purpose = args.purpose as string;
      const roles = args.roles as Array<{ name: string; description: string }>;

      if (!teamName?.trim() || !purpose?.trim() || !roles?.length) {
        return finish({ status: 'error', error: 'team_name, purpose, and roles are required' });
      }

      const teamId = randomUUID();
      const db = getDb();
      const settings = { purpose, workflow_id: state.id };

      db.prepare(`INSERT INTO teams (id, name, owner_id, settings) VALUES (?, ?, ?, ?)`).run(
        teamId, teamName.trim(), state.userId, JSON.stringify(settings)
      );

      // Add the orchestrator as owner member
      db.prepare(`INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, 'owner')`).run(
        teamId, state.userId
      );

      // Register each role as a shared context so teammates know their assignments
      for (const role of roles) {
        const contextId = randomUUID();
        db.prepare(`INSERT INTO team_shared_contexts (id, team_id, name, content, content_type, created_by) VALUES (?, ?, ?, ?, 'shared_instructions', ?)`).run(
          contextId, teamId, `role:${role.name}`, role.description, state.userId
        );
      }

      emitWorkflowEvent(state, {
        type: 'team_created',
        workflow_id: state.id,
        data: {
          team_id: teamId,
          team_name: teamName,
          purpose,
          roles: roles.map(r => r.name),
        },
      });

      return finish({
        status: 'ok',
        team_id: teamId,
        team_name: teamName,
        purpose,
        roles: roles.map(r => ({ name: r.name, description: r.description })),
        member_count: 1,
      });
    }

    case 'message_teammate': {
      const teamName = args.team_name as string;
      const to = args.to as string;
      const message = args.message as string;
      const priority = (args.priority as string) ?? 'normal';

      if (!teamName?.trim() || !to?.trim() || !message?.trim()) {
        return finish({ status: 'error', error: 'team_name, to, and message are required' });
      }

      const db = getDb();
      const team = db.prepare(`SELECT id, name FROM teams WHERE name = ? AND owner_id = ?`).get(teamName, state.userId) as { id: string; name: string } | undefined;
      if (!team) {
        return finish({ status: 'error', error: 'team_not_found', team_name: teamName });
      }

      // Store message as a shared context (message inbox pattern)
      const msgId = randomUUID();
      const msgContent = JSON.stringify({
        from: 'orchestrator',
        to,
        message: message.trim(),
        priority,
        sent_at: new Date().toISOString(),
        workflow_id: state.id,
      });

      db.prepare(`INSERT INTO team_shared_contexts (id, team_id, name, content, content_type, created_by) VALUES (?, ?, ?, ?, 'message', ?)`).run(
        msgId, team.id, `msg:${to}:${Date.now()}`, msgContent, state.userId
      );

      emitWorkflowEvent(state, {
        type: 'team_message_sent',
        workflow_id: state.id,
        data: { team_name: teamName, to, priority, preview: message.trim().slice(0, 120) },
      });

      return finish({ status: 'ok', message_id: msgId, team_name: teamName, to, priority });
    }

    case 'check_team_status': {
      const teamName = args.team_name as string;
      if (!teamName?.trim()) {
        return finish({ status: 'error', error: 'team_name is required' });
      }

      const db = getDb();
      const team = db.prepare(`SELECT id, name, settings FROM teams WHERE name = ? AND owner_id = ?`).get(teamName, state.userId) as { id: string; name: string; settings: string } | undefined;
      if (!team) {
        return finish({ status: 'error', error: 'team_not_found', team_name: teamName });
      }

      const members = db.prepare(`SELECT user_id, role FROM team_members WHERE team_id = ?`).all(team.id) as Array<{ user_id: string; role: string }>;
      const contexts = db.prepare(`SELECT name, content_type, created_at FROM team_shared_contexts WHERE team_id = ? ORDER BY created_at DESC LIMIT 20`).all(team.id) as Array<{ name: string; content_type: string; created_at: string }>;

      const roles = contexts.filter(c => c.name.startsWith('role:')).map(c => c.name.replace('role:', ''));
      const messages = contexts.filter(c => c.content_type === 'message');
      const settings = JSON.parse(team.settings || '{}');

      return finish({
        status: 'ok',
        team_name: teamName,
        team_id: team.id,
        purpose: settings.purpose ?? '',
        member_count: members.length,
        roles,
        pending_messages: messages.length,
        recent_activity: contexts.slice(0, 5).map(c => ({
          type: c.content_type,
          name: c.name,
          at: c.created_at,
        })),
      });
    }

    case 'dissolve_team': {
      const teamName = args.team_name as string;
      const summary = args.summary as string;

      if (!teamName?.trim()) {
        return finish({ status: 'error', error: 'team_name is required' });
      }

      const db = getDb();
      const team = db.prepare(`SELECT id, name FROM teams WHERE name = ? AND owner_id = ?`).get(teamName, state.userId) as { id: string; name: string } | undefined;
      if (!team) {
        return finish({ status: 'error', error: 'team_not_found', team_name: teamName });
      }

      // Collect final outputs before dissolution
      const contexts = db.prepare(`SELECT name, content, content_type FROM team_shared_contexts WHERE team_id = ?`).all(team.id) as Array<{ name: string; content: string; content_type: string }>;
      const roles = contexts.filter(c => c.name.startsWith('role:')).map(c => c.name.replace('role:', ''));

      // Clean up: delete contexts, members, then team
      db.prepare(`DELETE FROM team_shared_contexts WHERE team_id = ?`).run(team.id);
      db.prepare(`DELETE FROM team_members WHERE team_id = ?`).run(team.id);
      db.prepare(`DELETE FROM teams WHERE id = ?`).run(team.id);

      emitWorkflowEvent(state, {
        type: 'team_dissolved',
        workflow_id: state.id,
        data: { team_name: teamName, summary: summary ?? 'Team dissolved', roles },
      });

      return finish({
        status: 'ok',
        team_name: teamName,
        dissolved: true,
        roles_dissolved: roles,
        summary: summary ?? 'Team work complete',
      });
    }

    default:
      return finish({ status: 'error', error: 'unknown_tool', tool: name });
  }
};
