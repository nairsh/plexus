import { WorkflowError } from '@orchestrator/shared';
import type { OutputBlock, Tool } from '@orchestrator/shared';

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export const ORCHESTRATOR_TOOLS: Tool[] = [
  { type: 'web_search' },
  { type: 'fetch_url' },
  { type: 'bash' },
  { type: 'file_read' },
  { type: 'file_write' },
  { type: 'file_edit' },
  { type: 'grep' },
  { type: 'glob' },
  { type: 'search_knowledge' },
  { type: 'run_skill' },
  {
    type: 'function',
    function: {
      name: 'write_todo',
      description:
        'Create a new todo item. Use this when you need to break work into discrete tasks that may run in parallel or sequence.',
      parameters: {
        type: 'object',
        properties: {
          todo_id: { type: 'string', description: 'Unique identifier for this todo' },
          description: { type: 'string', description: 'What needs to be done' },
          agent_type: {
            type: 'string',
            enum: ['research', 'analyze', 'write', 'code', 'file', 'deep_research'],
            description: 'Which specialist agent should handle this',
          },
          depends_on: {
            type: 'array',
            items: { type: 'string' },
            description: 'IDs of todos that must complete before this one can start',
          },
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
      description:
        'Update a todo item. Use this to change status (pending, running, completed, failed, skipped), add output, or modify details.',
      parameters: {
        type: 'object',
        properties: {
          todo_id: { type: 'string' },
          description: { type: 'string', description: 'New description (optional)' },
          depends_on: { type: 'array', items: { type: 'string' }, description: 'New dependencies (optional)' },
          status: {
            type: 'string',
            enum: ['pending', 'running', 'completed', 'failed', 'skipped'],
            description: 'New status',
          },
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
          status: {
            type: 'string',
            enum: ['pending', 'running', 'completed', 'failed', 'skipped'],
            description: 'Filter by status',
          },
          agent_type: {
            type: 'string',
            enum: ['research', 'analyze', 'write', 'code', 'file', 'deep_research'],
            description: 'Filter by agent type',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'spawn_subagent',
      description:
        'Start executing a ready todo by spawning a specialized subagent. Only works if todo status is pending and dependencies are satisfied.',
      parameters: {
        type: 'object',
        properties: {
          todo_id: { type: 'string' },
          description: {
            type: 'string',
            description: 'One-line natural language label for this subagent task in the UI',
          },
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
          todo_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Specific todos to wait for (optional, waits for all running if omitted)',
          },
          timeout_seconds: { type: 'number', description: 'Maximum time to wait', default: 30 },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'request_clarification',
      description:
        'Pause the workflow and ask the user for clarification when the request is ambiguous or missing critical information. MUST provide 2-3 predefined options for the user to select from, plus an optional custom input option. The workflow will resume when the user provides the clarification.',
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'The specific question to ask the user for clarification',
          },
          options: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: 'Short display text for this choice' },
                description: { type: 'string', description: 'Optional longer explanation of this choice' },
              },
              required: ['label'],
            },
            minItems: 2,
            maxItems: 3,
            description:
              'REQUIRED: 2-3 predefined answer options the user can select from. Must provide at least 2 options.',
          },
          allow_custom: {
            type: 'boolean',
            description:
              'Whether to allow a custom free-text response as an additional option. Defaults to true. When true, adds a "Other (specify)" option at the end.',
          },
        },
        required: ['question', 'options'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_memory',
      description:
        "Save a piece of information to the user's persistent memory so it can be recalled in future sessions. Use this when the user explicitly asks you to remember something, or when you learn a stable preference or fact worth preserving.",
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The information to remember' },
          category: {
            type: 'string',
            description: 'Category for this memory (e.g. "preference", "project", "research"). Defaults to "general".',
          },
        },
        required: ['content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_team',
      description:
        'Create an agent team for parallel collaborative work. The team is ephemeral — it exists only for this workflow. Define a purpose and roles, then assign tasks to teammates who work independently and communicate peer-to-peer.',
      parameters: {
        type: 'object',
        properties: {
          team_name: {
            type: 'string',
            description: 'Short name for this team (e.g. "research-squad", "content-pipeline")',
          },
          purpose: { type: 'string', description: 'What this team is assembled to accomplish' },
          roles: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Role name (e.g. "researcher", "writer", "reviewer")' },
                description: { type: 'string', description: 'What this role is responsible for' },
              },
              required: ['name', 'description'],
            },
            description: 'The roles needed on this team (2-6 roles)',
          },
        },
        required: ['team_name', 'purpose', 'roles'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'message_teammate',
      description:
        'Send an async message to a teammate. Use this to assign work, share context, or relay results between agents. The teammate will process the message in their own context.',
      parameters: {
        type: 'object',
        properties: {
          team_name: { type: 'string', description: 'Name of the team' },
          to: { type: 'string', description: 'Role name of the recipient teammate' },
          message: { type: 'string', description: 'The message content — task assignment, context, or results' },
          priority: {
            type: 'string',
            enum: ['normal', 'urgent'],
            description: 'Message priority. Defaults to normal.',
          },
        },
        required: ['team_name', 'to', 'message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_team_status',
      description:
        'Check the current status of all teammates in a team — who is working, who has finished, and any messages waiting.',
      parameters: {
        type: 'object',
        properties: {
          team_name: { type: 'string', description: 'Name of the team to check' },
        },
        required: ['team_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'dissolve_team',
      description:
        'Dissolve a team after its work is complete. Collects final outputs from all teammates and cleans up resources. Always dissolve teams when done.',
      parameters: {
        type: 'object',
        properties: {
          team_name: { type: 'string', description: 'Name of the team to dissolve' },
          summary: { type: 'string', description: 'Brief summary of what the team accomplished' },
        },
        required: ['team_name'],
      },
    },
  },
];

export const extractToolCallsFromOutput = (output: OutputBlock[]): ToolCall[] => {
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
};

export const normalizeToolCall = (call: ToolCall): ToolCall => {
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
};
