import Anthropic from '@anthropic-ai/sdk';
import {
  SchemaType,
  type FunctionDeclaration,
  type Tool as GoogleTool,
} from '@google/generative-ai';
import { getErrorMessage, logger } from '@orchestrator/shared';
import type { AgentRequest, OutputBlock, Tool } from '@orchestrator/shared';
import type OpenAI from 'openai';
import {
  executeBash,
  executeEditFile,
  executeGlob,
  executeGrep,
  executeReadFile,
  executeWriteFile,
} from './fileOperations.js';
import { applySkillToRequest, getSkillById } from '../skills.js';
import { fetchUrl, searchWeb } from './tavily.js';
import { getOpenTerminalSessionForChat } from './workspaceAccess.js';
import type { ToolApprovalDecision } from '@orchestrator/shared';

type BuiltinToolName = Exclude<Tool['type'], 'function'>;
type ToolParameters = Record<string, unknown>;

interface CanonicalToolDefinition {
  name: BuiltinToolName;
  description: string;
  parameters: ToolParameters;
  cost: number;
}

export interface ToolCallResult {
  output: string;
  cost: number;
  systemMessage?: string;
}

const trivialCommandPattern = /^\s*(pwd|ls|la|ll|dir|which|whereis|whoami|git status|git diff|git log|node -v|npm -v|pnpm -v)(\s+.*)?$/i;

const normalizeCommandKey = (command: string): string => command.trim().split(/\s+/)[0]?.toLowerCase() ?? 'bash';

const getCommandApprovalReason = (command: string): string | null => {
  const trimmed = command.trim();
  if (!trimmed) return 'Empty command';
  if (trivialCommandPattern.test(trimmed)) return null;
  return 'This command can modify files, install dependencies, or change repository state.';
};

const requestCommandApproval = async (request: AgentRequest, command: string): Promise<ToolApprovalDecision> => {
  const reason = getCommandApprovalReason(command);
  if (!reason) return 'approve';
  if (!request.trace?.onToolApprovalRequest) return 'approve';
  return request.trace.onToolApprovalRequest({
    name: 'bash',
    input: { command },
    reason,
    command_key: normalizeCommandKey(command),
    model: request.trace.model,
    workflow_id: request.trace.workflow_id,
    subagent_id: request.trace.subagent_id,
  });
};

const BUILTIN_TOOL_NAMES = new Set<BuiltinToolName>([
  'web_search',
  'fetch_url',
  'code_execution',
  'file_read',
  'file_write',
  'file_edit',
  'bash',
  'grep',
  'glob',
  'run_skill',
]);

const FILE_CONTEXT_ERROR = {
  error: 'File operations require a chat context. Please create a workflow with a chat_id.',
};

const WORKSPACE_MISSING_ERROR = {
  error: 'No active workspace found for this chat. Please initialize a sandbox session first.',
};

export const CANONICAL_TOOL_DEFS = new Map<BuiltinToolName, CanonicalToolDefinition>([
  [
    'web_search',
    {
      name: 'web_search',
      description: 'Search the web for current information on a topic. Use basic depth by default; request advanced depth only when necessary. Use fetch_url for full page content.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query' },
          search_depth: {
            type: 'string',
            enum: ['basic', 'advanced'],
            description: 'Search depth; basic is the default and should be used normally',
          },
        },
        required: ['query'],
      },
      cost: 0.005,
    },
  ],
  [
    'fetch_url',
    {
      name: 'fetch_url',
      description: 'Fetch the content of a URL and return it as markdown',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL to fetch' },
        },
        required: ['url'],
      },
      cost: 0.001,
    },
  ],
  [
    'code_execution',
    {
      name: 'code_execution',
      description: 'Execute code in a sandboxed environment. Specify the language and code to run.',
      parameters: {
        type: 'object',
        properties: {
          language: {
            type: 'string',
            enum: ['python', 'javascript'],
            description: 'Programming language',
          },
          code: { type: 'string', description: 'The code to execute' },
        },
        required: ['language', 'code'],
      },
      cost: 0,
    },
  ],
  [
    'file_read',
    {
      name: 'file_read',
      description: 'Read the contents of a file or list directory contents. Use limit/offset for large files.',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Absolute path to the file or directory to read' },
          limit: { type: 'number', description: 'Maximum number of lines to read (optional)' },
          offset: { type: 'number', description: 'Line number to start reading from (1-indexed, optional)' },
        },
        required: ['filePath'],
      },
      cost: 0.001,
    },
  ],
  [
    'file_write',
    {
      name: 'file_write',
      description: 'Write content to a file. Creates the file if it does not exist, overwrites if it does.',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Absolute path to the file to write' },
          content: { type: 'string', description: 'The content to write to the file' },
        },
        required: ['filePath', 'content'],
      },
      cost: 0.001,
    },
  ],
  [
    'file_edit',
    {
      name: 'file_edit',
      description: 'Edit a file by replacing an old string with a new string. The oldString must match exactly.',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Absolute path to the file to edit' },
          oldString: { type: 'string', description: 'The exact string to replace' },
          newString: { type: 'string', description: 'The new string to replace it with' },
        },
        required: ['filePath', 'oldString', 'newString'],
      },
      cost: 0.001,
    },
  ],
  [
    'bash',
    {
      name: 'bash',
      description: 'Execute a bash command in the workspace. Use for git operations, file manipulation, and system commands.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The bash command to execute' },
          timeoutSeconds: { type: 'number', description: 'Timeout in seconds (default: 60, max: 300)' },
        },
        required: ['command'],
      },
      cost: 0.001,
    },
  ],
  [
    'grep',
    {
      name: 'grep',
      description: 'Search file contents for a pattern using grep. Returns matching lines with file paths and line numbers.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'The search pattern (regex supported)' },
          path: { type: 'string', description: 'Directory or file path to search (default: current directory)' },
          include: { type: 'string', description: 'File pattern to include, e.g., "*.ts" (optional)' },
        },
        required: ['pattern'],
      },
      cost: 0.001,
    },
  ],
  [
    'glob',
    {
      name: 'glob',
      description: 'Find files matching a glob pattern. Returns a list of file paths.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'The glob pattern, e.g., "**/*.ts" or "*.json"' },
          path: { type: 'string', description: 'Directory to search in (default: current directory)' },
        },
        required: ['pattern'],
      },
      cost: 0.001,
    },
  ],
  [
    'run_skill',
    {
      name: 'run_skill',
      description: 'Activate a skill by id and optionally provide input',
      parameters: {
        type: 'object',
        properties: {
          skill_id: { type: 'string', description: 'Skill id to activate' },
          input: { type: 'string', description: 'Optional input for the skill' },
        },
        required: ['skill_id'],
      },
      cost: 0,
    },
  ],
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const parseToolArgs = (rawArgs: unknown): Record<string, unknown> => {
  if (typeof rawArgs === 'string') {
    const parsed = JSON.parse(rawArgs) as unknown;
    return isRecord(parsed) ? parsed : {};
  }

  return isRecord(rawArgs) ? rawArgs : {};
};

const getTraceContext = (request: AgentRequest) => ({
  model: request.trace?.model,
  workflow_id: request.trace?.workflow_id,
  subagent_id: request.trace?.subagent_id,
});

const traceToolCall = async (request: AgentRequest, name: string, input: Record<string, unknown>): Promise<void> => {
  await request.trace?.onToolCall?.({
    name,
    input,
    ...getTraceContext(request),
  });
};

const traceToolResult = async (
  request: AgentRequest,
  name: string,
  input: Record<string, unknown>,
  output: unknown,
): Promise<void> => {
  await request.trace?.onToolResult?.({
    name,
    input,
    output,
    ...getTraceContext(request),
  });
};

const getWorkspaceSession = async (request: AgentRequest) => {
  if (!request.chat_id) {
    return null;
  }

  return getOpenTerminalSessionForChat(request.chat_id);
};

const getToolDefinition = (tool: Tool): CanonicalToolDefinition | null => {
  if (!BUILTIN_TOOL_NAMES.has(tool.type as BuiltinToolName)) {
    return null;
  }

  return CANONICAL_TOOL_DEFS.get(tool.type as BuiltinToolName) ?? null;
};

const toOpenAITool = (name: string, description: string, parameters: ToolParameters): OpenAI.ChatCompletionTool => ({
  type: 'function',
  function: {
    name,
    description,
    parameters,
  },
});

const toAnthropicTool = (name: string, description: string, parameters: ToolParameters): Anthropic.Tool => ({
  name,
  description,
  input_schema: {
    type: 'object',
    ...(parameters as Record<string, unknown>),
  },
});

const toGoogleSchema = (schema: unknown): unknown => {
  if (!isRecord(schema)) return undefined;

  const rawType = schema['type'];
  const converted: Record<string, unknown> = {};

  if (typeof rawType === 'string') {
    const mappedType = {
      string: SchemaType.STRING,
      number: SchemaType.NUMBER,
      integer: SchemaType.INTEGER,
      boolean: SchemaType.BOOLEAN,
      array: SchemaType.ARRAY,
      object: SchemaType.OBJECT,
    }[rawType];

    if (mappedType) {
      converted['type'] = mappedType;
    }
  }

  if (typeof schema['description'] === 'string') {
    converted['description'] = schema['description'];
  }

  if (Array.isArray(schema['enum'])) {
    converted['enum'] = schema['enum'];
  }

  if (Array.isArray(schema['required'])) {
    converted['required'] = schema['required'];
  }

  if (isRecord(schema['properties'])) {
    converted['properties'] = Object.fromEntries(
      Object.entries(schema['properties']).map(([key, value]) => [key, toGoogleSchema(value)]),
    );
  }

  if (schema['items'] !== undefined) {
    converted['items'] = toGoogleSchema(schema['items']);
  }

  return converted;
};

const toGoogleDeclaration = (name: string, description: string, parameters: ToolParameters): FunctionDeclaration => ({
  name,
  description,
  parameters: toGoogleSchema(parameters) as FunctionDeclaration['parameters'],
});

const collectToolSpecs = (tools?: Tool[]): Array<{ name: string; description: string; parameters: ToolParameters }> => {
  if (!tools || tools.length === 0) return [];

  return tools.flatMap((tool) => {
    if (tool.type === 'function' && tool.function) {
      return [{
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters as ToolParameters,
      }];
    }

    const definition = getToolDefinition(tool);
    return definition
      ? [{
          name: definition.name,
          description: definition.description,
          parameters: definition.parameters,
        }]
      : [];
  });
};

export const buildOpenAITools = (tools?: Tool[]): OpenAI.ChatCompletionTool[] | undefined => {
  const specs = collectToolSpecs(tools);
  if (specs.length === 0) return undefined;
  return specs.map((spec) => toOpenAITool(spec.name, spec.description, spec.parameters));
};

export const buildAnthropicTools = (tools?: Tool[]): Anthropic.Tool[] | undefined => {
  const specs = collectToolSpecs(tools);
  if (specs.length === 0) return undefined;
  return specs.map((spec) => toAnthropicTool(spec.name, spec.description, spec.parameters));
};

export const buildGoogleTools = (tools?: Tool[]): GoogleTool[] | undefined => {
  const specs = collectToolSpecs(tools);
  if (specs.length === 0) return undefined;
  return [{ functionDeclarations: specs.map((spec) => toGoogleDeclaration(spec.name, spec.description, spec.parameters)) }];
};

export const executeToolCall = async (
  name: string,
  rawArgs: unknown,
  request: AgentRequest,
  outputBlocks: OutputBlock[],
): Promise<ToolCallResult> => {
  try {
    const args = parseToolArgs(rawArgs);

    if (name === 'run_skill') {
      const skillId = typeof args['skill_id'] === 'string' ? args['skill_id'] : undefined;
      if (!skillId) {
        return { output: JSON.stringify({ error: 'skill_id is required' }), cost: 0 };
      }
      if (request.allowed_skills && !request.allowed_skills.includes(skillId)) {
        return { output: JSON.stringify({ error: 'skill not allowed' }), cost: 0 };
      }

      const skill = getSkillById(skillId);
      if (!skill) {
        return { output: JSON.stringify({ error: 'skill not found' }), cost: 0 };
      }

      const { systemMessage } = applySkillToRequest(
        request,
        skill,
        typeof args['input'] === 'string' ? args['input'] : undefined,
      );

      return {
        output: JSON.stringify({ status: 'activated', skill_id: skillId }),
        cost: 0,
        systemMessage,
      };
    }

    if (name === 'web_search') {
      const input = { query: args['query'], search_depth: args['search_depth'] };
      await traceToolCall(request, name, input);
      const results = await searchWeb(String(args['query'] ?? ''), {
        searchDepth: args['search_depth'] === 'advanced' ? 'advanced' : 'basic',
      });
      outputBlocks.push({ type: 'search_results', results });
      await traceToolResult(request, name, input, results);
      return { output: JSON.stringify(results), cost: CANONICAL_TOOL_DEFS.get('web_search')!.cost };
    }

    if (name === 'fetch_url') {
      const input = { url: args['url'] };
      await traceToolCall(request, name, input);
      const content = await fetchUrl(String(args['url'] ?? ''));
      outputBlocks.push({ type: 'fetch_url_results', url: args['url'], content });
      await traceToolResult(request, name, input, content);
      return { output: JSON.stringify(content), cost: CANONICAL_TOOL_DEFS.get('fetch_url')!.cost };
    }

    if (name === 'code_execution') {
      return {
        output: JSON.stringify({
          note: 'Code execution tool available via sandbox API. Use POST /v1/sandbox/sessions for standalone execution.',
          language: args['language'],
          code: args['code'],
        }),
        cost: 0,
      };
    }

    if (['file_read', 'file_write', 'file_edit', 'bash', 'grep', 'glob'].includes(name)) {
      if (!request.chat_id) {
        return { output: JSON.stringify(FILE_CONTEXT_ERROR), cost: 0 };
      }

      const session = await getWorkspaceSession(request);
      if (!session) {
        return { output: JSON.stringify(WORKSPACE_MISSING_ERROR), cost: 0 };
      }

      if (name === 'file_read') {
        const input = { filePath: args['filePath'], limit: args['limit'], offset: args['offset'] };
        await traceToolCall(request, name, input);
        const result = await executeReadFile(
          session,
          String(args['filePath'] ?? ''),
          typeof args['limit'] === 'number' ? args['limit'] : undefined,
          typeof args['offset'] === 'number' ? args['offset'] : undefined,
        );
        outputBlocks.push({ type: 'file_read_result', result });
        await traceToolResult(request, name, { filePath: args['filePath'] }, result);
        return { output: JSON.stringify(result), cost: CANONICAL_TOOL_DEFS.get('file_read')!.cost };
      }

      if (name === 'file_write') {
        const input = {
          filePath: args['filePath'],
          contentLength: typeof args['content'] === 'string' ? args['content'].length : undefined,
        };
        await traceToolCall(request, name, input);
        const result = await executeWriteFile(session, String(args['filePath'] ?? ''), String(args['content'] ?? ''));
        outputBlocks.push({ type: 'file_write_result', result });
        await traceToolResult(request, name, { filePath: args['filePath'] }, result);
        return { output: JSON.stringify(result), cost: CANONICAL_TOOL_DEFS.get('file_write')!.cost };
      }

      if (name === 'file_edit') {
        const input = {
          filePath: args['filePath'],
          oldStringLength: typeof args['oldString'] === 'string' ? args['oldString'].length : undefined,
          newStringLength: typeof args['newString'] === 'string' ? args['newString'].length : undefined,
        };
        await traceToolCall(request, name, input);
        const result = await executeEditFile(
          session,
          String(args['filePath'] ?? ''),
          String(args['oldString'] ?? ''),
          String(args['newString'] ?? ''),
        );
        outputBlocks.push({ type: 'file_edit_result', result });
        await traceToolResult(request, name, { filePath: args['filePath'] }, result);
        return { output: JSON.stringify(result), cost: CANONICAL_TOOL_DEFS.get('file_edit')!.cost };
      }

      if (name === 'bash') {
        const input = { command: args['command'], timeoutSeconds: args['timeoutSeconds'] };
        await traceToolCall(request, name, input);
        const approval = await requestCommandApproval(request, String(args['command'] ?? ''));
        if (approval === 'deny') {
          const deniedResult = {
            stdout: '',
            stderr: 'Command denied by user',
            exit_code: 1,
            command: String(args['command'] ?? ''),
            interrupted: false,
          };
          outputBlocks.push({ type: 'bash_result', result: deniedResult });
          await traceToolResult(request, name, { command: args['command'] }, deniedResult);
          return { output: JSON.stringify(deniedResult), cost: 0 };
        }
        const result = await executeBash(
          session,
          String(args['command'] ?? ''),
          typeof args['timeoutSeconds'] === 'number' ? args['timeoutSeconds'] : undefined,
          request.signal,
        );
        outputBlocks.push({ type: 'bash_result', result });
        await traceToolResult(request, name, { command: args['command'] }, result);
        return { output: JSON.stringify(result), cost: CANONICAL_TOOL_DEFS.get('bash')!.cost };
      }

      if (name === 'grep') {
        const input = { pattern: args['pattern'], path: args['path'], include: args['include'] };
        await traceToolCall(request, name, input);
        const result = await executeGrep(
          session,
          String(args['pattern'] ?? ''),
          typeof args['path'] === 'string' ? args['path'] : undefined,
          typeof args['include'] === 'string' ? args['include'] : undefined,
        );
        outputBlocks.push({ type: 'grep_result', result });
        await traceToolResult(request, name, { pattern: args['pattern'], path: args['path'] }, result);
        return { output: JSON.stringify(result), cost: CANONICAL_TOOL_DEFS.get('grep')!.cost };
      }

      if (name === 'glob') {
        const input = { pattern: args['pattern'], path: args['path'] };
        await traceToolCall(request, name, input);
        const result = await executeGlob(
          session,
          String(args['pattern'] ?? ''),
          typeof args['path'] === 'string' ? args['path'] : undefined,
        );
        outputBlocks.push({ type: 'glob_result', result });
        await traceToolResult(request, name, input, result);
        return { output: JSON.stringify(result), cost: CANONICAL_TOOL_DEFS.get('glob')!.cost };
      }
    }

    return { output: JSON.stringify({ error: `Unknown tool: ${name}` }), cost: 0 };
  } catch (err) {
    logger.error({ name, error: getErrorMessage(err) }, 'Tool execution failed');
    return { output: JSON.stringify({ error: getErrorMessage(err) }), cost: 0 };
  }
};
