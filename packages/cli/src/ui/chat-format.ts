import type { WorkflowTraceStep } from '@orchestrator/shared';
import type { WorkflowHistoryItem } from './chat-state.js';

const truncate = (text: string, maxLength: number): string => {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
};

export interface TodoListItem {
  id: string;
  description: string;
  status: string;
}

export const formatDuration = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}m ${remaining}s`;
};

export const formatTokenCount = (tokens: number): string => {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(tokens >= 10_000 ? 0 : 1)}k`;
  return `${tokens}`;
};

export const formatCompletionLabel = (durationMs: number, credits?: number, tokens?: number): string => {
  const parts = [`Brewed for ${formatDuration(durationMs)}`];
  if (tokens && tokens > 0) {
    parts.push(`${formatTokenCount(tokens)} tokens`);
  }
  if (credits !== undefined) {
    parts.push(`${credits.toFixed(4)} credits`);
  }
  return parts.join(' · ');
};

export const formatToolPreview = (toolName: string, toolInput: unknown): { title: string; detail?: string } => {
  const input = toolInput as Record<string, unknown> | null;
  const todoLabel =
    (typeof input?.description === 'string' && input.description.trim()) ||
    (typeof input?.display_todo_id === 'string' && input.display_todo_id.trim()) ||
    (typeof input?.todo_id === 'string' && input.todo_id.trim()) ||
    undefined;
  const primary =
    input?.description ??
    input?.question ??
    input?.pattern ??
    input?.query ??
    input?.filePath ??
    input?.path ??
    input?.url ??
    input?.command ??
    input?.todo_id ??
    input?.workflowId;

  const preview = typeof primary === 'string' ? primary : undefined;

  switch (toolName) {
    case 'write_todo':
      return {
        title: 'Created todo',
        detail: typeof input?.description === 'string' ? input.description : preview,
      };
    case 'edit_todo':
      return {
        title: 'Updated todo',
        detail: todoLabel ?? preview,
      };
    case 'list_todos':
      return { title: 'Listed todos' };
    case 'spawn_subagent':
      return {
        title: 'Spawned subagent',
        detail: todoLabel ?? preview,
      };
    case 'await_subagents':
      return { title: 'Waiting on subagents' };
    case 'glob':
    case 'grep':
      return { title: 'Searching workspace', detail: preview };
    case 'read':
    case 'file_read':
      return { title: 'Reading file', detail: preview };
    case 'edit':
    case 'file_edit':
      return { title: 'Editing file', detail: preview };
    case 'file_write':
      return { title: 'Writing file', detail: preview };
    case 'bash':
      return { title: 'Running command', detail: preview };
    case 'web_search':
      return { title: 'Searching web', detail: preview };
    case 'fetch_url':
      return { title: 'Fetching URL', detail: preview };
    default:
      return { title: toolName, detail: preview };
  }
};

const capitalize = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);

export const formatToolDescription = (toolInput: unknown): string | undefined => {
  const input = toolInput as Record<string, unknown> | null;
  if (!input) return undefined;

  const candidates = [input.description, input.title, input.display_todo_id, input.todo_id];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return undefined;
};

export const formatToolLabel = (toolName: string, toolInput: unknown): string => {
  const input = toolInput as Record<string, unknown> | null;
  const todoLabel =
    (typeof input?.description === 'string' && input.description.trim()) ||
    (typeof input?.display_todo_id === 'string' && input.display_todo_id.trim()) ||
    (typeof input?.todo_id === 'string' && input.todo_id.trim()) ||
    '';
  const primary =
    input?.description ??
    input?.question ??
    input?.pattern ??
    input?.query ??
    input?.filePath ??
    input?.path ??
    input?.url ??
    input?.command ??
    input?.todo_id ??
    input?.workflowId;
  const preview = typeof primary === 'string' ? truncate(primary.trim(), 40) : '';

  switch (toolName) {
    case 'bash':
      return `Bash(${preview || 'command'})`;
    case 'file_write':
      return `Write(${preview || 'file'})`;
    case 'file_read':
    case 'read':
      return `Read(${preview || 'file'})`;
    case 'file_edit':
    case 'edit':
      return `Edit(${preview || 'file'})`;
    case 'grep':
      return `Grep(${preview || 'pattern'})`;
    case 'glob':
      return `Glob(${preview || 'pattern'})`;
    case 'web_search':
      return `WebSearch(${preview || 'query'})`;
    case 'fetch_url':
      return `Fetch(${preview || 'url'})`;
    case 'spawn_subagent':
      return `Spawn subagent${todoLabel ? ` (${truncate(todoLabel, 40)})` : ''}`;
    case 'await_subagents':
      return 'Await subagents';
    case 'write_todo':
    case 'edit_todo':
    case 'list_todos':
      return 'Update Todos';
    default:
      return preview ? `${capitalize(toolName)}(${preview})` : capitalize(toolName);
  }
};

export const formatAgentLabel = (agentType: string): string => {
  switch (agentType) {
    case 'research':
      return 'Researcher';
    case 'analyze':
      return 'Analyst';
    case 'write':
      return 'Writer';
    case 'code':
      return 'Coder';
    case 'file':
      return 'File Agent';
    case 'deep_research':
      return 'Deep Researcher';
    default:
      return agentType.charAt(0).toUpperCase() + agentType.slice(1);
  }
};

export const summarizeToolStep = (toolName: string, toolInput: unknown, toolOutput?: unknown): string => {
  const detail = formatToolResultDetail(toolName, toolOutput);
  if (detail) return detail;
  return formatToolPreview(toolName, toolInput).detail ?? '(No content)';
};

export const formatToolResultDetail = (toolName: string, toolOutput: unknown): string | undefined => {
  const output = toolOutput as Record<string, unknown> | null;
  if (!output || typeof output !== 'object') return undefined;

  switch (toolName) {
    case 'web_search': {
      const results = Array.isArray(output.results)
        ? output.results.length
        : Array.isArray(output.answer)
          ? output.answer.length
          : undefined;
      if (typeof results === 'number') {
        return `${results} result${results === 1 ? '' : 's'}`;
      }
      if (typeof output.query === 'string') return output.query;
      return undefined;
    }
    case 'fetch_url': {
      if (typeof output.url === 'string') return output.url;
      if (typeof output.content === 'string' && output.content.trim()) {
        return output.content.trim().split('\n')[0]?.slice(0, 120);
      }
      return undefined;
    }
    case 'bash': {
      const stdout = typeof output.stdout === 'string' ? output.stdout.trim() : '';
      const stderr = typeof output.stderr === 'string' ? output.stderr.trim() : '';
      const exitCode = typeof output.exit_code === 'number' ? output.exit_code : 0;
      if (stdout) {
        const firstLine = stdout.split('\n')[0]?.trim();
        if (firstLine) return firstLine;
      }
      if (stderr) {
        const firstLine = stderr.split('\n')[0]?.trim();
        if (firstLine) return firstLine;
      }
      return exitCode === 0 ? '(No content)' : `Exit code ${exitCode}`;
    }
    case 'file_write': {
      const path = typeof output.path === 'string' ? output.path : 'file';
      const bytes = typeof output.bytes_written === 'number' ? output.bytes_written : undefined;
      return bytes !== undefined ? `Wrote ${bytes} bytes to ${path}` : `Wrote ${path}`;
    }
    case 'file_edit': {
      const path = typeof output.path === 'string' ? output.path : 'file';
      return `Updated ${path}`;
    }
    case 'file_read':
    case 'read': {
      const path = typeof output.path === 'string' ? output.path : undefined;
      if (Array.isArray(output.entries)) {
        return `${output.entries.length} entries${path ? ` in ${path}` : ''}`;
      }
      if (typeof output.content === 'string') {
        const lines = output.content.split('\n').length;
        return `${lines} lines${path ? ` from ${path}` : ''}`;
      }
      return path;
    }
    case 'glob': {
      const matches = Array.isArray(output.matches) ? output.matches.length : 0;
      return `${matches} match${matches === 1 ? '' : 'es'}`;
    }
    case 'grep': {
      const matches = Array.isArray(output.matches) ? output.matches.length : 0;
      return `${matches} match${matches === 1 ? '' : 'es'}`;
    }
    case 'spawn_subagent': {
      const description = typeof output.description === 'string' ? output.description : undefined;
      const todoId =
        typeof output.display_todo_id === 'string'
          ? output.display_todo_id
          : typeof output.todo_id === 'string'
            ? output.todo_id
            : undefined;
      if (output.status === 'blocked') {
        return description ? `Waiting on dependencies for ${description}` : 'Waiting on dependencies';
      }
      if (output.status === 'skipped') {
        return description ? `Already settled: ${description}` : 'Already settled';
      }
      if (typeof output.error === 'string') return output.error;
      if (typeof output.run_id === 'string') {
        return description ?? todoId ?? 'Subagent started';
      }
      return description ?? todoId;
    }
    case 'await_subagents': {
      const completedResults = Array.isArray(output.completed_results)
        ? output.completed_results.filter((entry): entry is Record<string, unknown> =>
            Boolean(entry && typeof entry === 'object')
          )
        : [];
      if (completedResults.length > 0) {
        const labels = completedResults
          .map((entry) =>
            typeof entry.description === 'string'
              ? entry.description
              : typeof entry.display_todo_id === 'string'
                ? entry.display_todo_id
                : undefined
          )
          .filter((value): value is string => Boolean(value));
        if (labels.length > 0) {
          return `Completed: ${labels.join(', ')}`;
        }
      }
      const running = Array.isArray(output.running) ? output.running.length : 0;
      const failed = Array.isArray(output.failed) ? output.failed.length : 0;
      const completed = Array.isArray(output.completed) ? output.completed.length : 0;
      return `${completed} completed${running ? ` · ${running} running` : ''}${failed ? ` · ${failed} failed` : ''}`;
    }
    default:
      if (typeof output.error === 'string') return output.error;
      return undefined;
  }
};

export const getToolResultStatus = (toolOutput: unknown): 'done' | 'error' => {
  const output = toolOutput as Record<string, unknown> | null;
  if (!output || typeof output !== 'object') return 'done';
  if (typeof output.exit_code === 'number' && output.exit_code !== 0) return 'error';
  if (typeof output.status === 'string' && output.status === 'error') return 'error';
  if (typeof output.error === 'string' && output.error.length > 0) return 'error';
  return 'done';
};

export const isTodoTool = (toolName: string): boolean => {
  return toolName === 'write_todo' || toolName === 'edit_todo' || toolName === 'list_todos';
};

const getTodoDescription = (todo: Record<string, unknown>): string => {
  if (typeof todo.description === 'string' && todo.description.trim().length > 0) {
    return todo.description;
  }
  if (typeof todo.display_todo_id === 'string' && todo.display_todo_id.trim().length > 0) {
    return todo.display_todo_id;
  }
  if (typeof todo.id === 'string' && todo.id.trim().length > 0) {
    return todo.id;
  }
  return 'Todo';
};

export const extractTodoItemsFromTool = (
  toolName: string,
  toolInput: unknown,
  toolOutput?: unknown
): TodoListItem[] => {
  const input = toolInput as Record<string, unknown> | null;
  const output = toolOutput as Record<string, unknown> | null;

  if (toolName === 'list_todos') {
    const todos = Array.isArray(output?.todos) ? output.todos : [];
    return todos
      .filter((todo): todo is Record<string, unknown> => Boolean(todo && typeof todo === 'object'))
      .map((todo) => ({
        id: typeof todo.id === 'string' ? todo.id : '',
        description: getTodoDescription(todo),
        status: typeof todo.status === 'string' ? todo.status : 'pending',
      }));
  }

  if (toolName === 'write_todo') {
    return [
      {
        id:
          typeof output?.todo_id === 'string'
            ? output.todo_id
            : typeof input?.todo_id === 'string'
              ? input.todo_id
              : '',
        description:
          typeof input?.description === 'string'
            ? input.description
            : typeof output?.description === 'string'
              ? output.description
              : 'Todo',
        status: 'pending',
      },
    ];
  }

  if (toolName === 'edit_todo') {
    return [
      {
        id:
          typeof output?.todo_id === 'string'
            ? output.todo_id
            : typeof input?.todo_id === 'string'
              ? input.todo_id
              : '',
        description:
          typeof input?.description === 'string'
            ? input.description
            : typeof output?.description === 'string'
              ? output.description
              : typeof output?.display_todo_id === 'string'
                ? output.display_todo_id
                : 'Todo',
        status: typeof input?.status === 'string' ? input.status : 'pending',
      },
    ];
  }

  return [];
};

export const extractHistoryEntries = (
  trace: WorkflowTraceStep[]
): Array<{ type: 'assistant'; text: string } | { type: 'tool'; toolName: string; toolInput: unknown }> => {
  return trace.reduce<
    Array<{ type: 'assistant'; text: string } | { type: 'tool'; toolName: string; toolInput: unknown }>
  >((entries, step) => {
    if ((step.step_type === 'orchestrator_message' || step.step_type === 'subagent_message') && step.message_content) {
      entries.push({ type: 'assistant', text: step.message_content });
      return entries;
    }

    if ((step.step_type === 'tool_call' || step.step_type === 'subagent_tool_call') && step.tool_name) {
      entries.push({ type: 'tool', toolName: step.tool_name, toolInput: step.tool_input });
      return entries;
    }

    return entries;
  }, []);
};

export const formatWorkflowSummary = (workflow: WorkflowHistoryItem): string => {
  const status = workflow.status;
  const when = workflow.updated_at || workflow.created_at;
  return `${workflow.objective} · ${status} · ${when}`;
};
