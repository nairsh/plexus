/**
 * Canonical tool definitions and provider-specific schema builders.
 * Single source of truth for what each tool looks like across OpenAI, Anthropic, and Google adapters.
 */
import Anthropic from '@anthropic-ai/sdk';
import { SchemaType, type FunctionDeclaration, type Tool as GoogleTool } from '@google/generative-ai';
import type { Tool } from '@orchestrator/shared';
import type OpenAI from 'openai';

type BuiltinToolName = Exclude<Tool['type'], 'function'>;
export type ToolParameters = Record<string, unknown>;

export interface CanonicalToolDefinition {
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

export const BUILTIN_TOOL_NAMES = new Set<BuiltinToolName>([
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
  'remember',
  'recall',
  'search_knowledge',
  'github_api',
  'linear_api',
  'notion_api',
]);

export const CANONICAL_TOOL_DEFS = new Map<BuiltinToolName, CanonicalToolDefinition>([
  [
    'web_search',
    {
      name: 'web_search',
      description:
        'Search the web for current information on a topic. Use basic depth by default; request advanced depth only when necessary. Use fetch_url for full page content.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query' },
          search_depth: {
            type: 'string',
            enum: ['basic', 'advanced'],
            description: 'Search depth; basic is the default and should be used normally',
          },
          include_domains: {
            type: 'array',
            items: { type: 'string' },
            description: 'Only return results from these domains',
          },
          exclude_domains: {
            type: 'array',
            items: { type: 'string' },
            description: 'Exclude results from these domains',
          },
          days_recency: {
            type: 'number',
            description: 'Only return results from the last N days',
          },
          language: {
            type: 'string',
            description: 'Filter results by language code (e.g. "en", "fr")',
          },
          content_budget: {
            type: 'number',
            description: 'Maximum total characters of content to return',
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
      description:
        'Execute a bash command in the workspace. Use for git operations, file manipulation, and system commands.',
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
      description:
        'Search file contents for a pattern using grep. Returns matching lines with file paths and line numbers.',
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
  [
    'remember',
    {
      name: 'remember',
      description:
        'Save information to persistent memory for future sessions. Use for preferences, project context, or important facts.',
      parameters: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: 'Unique identifier for this memory (e.g., "user_preference_theme", "project_goal")',
          },
          content: { type: 'string', description: 'The content to remember' },
          category: {
            type: 'string',
            description: 'Category for organization (e.g., "preferences", "project", "research")',
          },
        },
        required: ['key', 'content'],
      },
      cost: 0,
    },
  ],
  [
    'recall',
    {
      name: 'recall',
      description: 'Search persistent memory for relevant information from past sessions.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query to find relevant memories' },
          limit: { type: 'number', description: 'Maximum number of memories to return (default: 5)' },
        },
        required: ['query'],
      },
      cost: 0,
    },
  ],
  [
    'search_knowledge',
    {
      name: 'search_knowledge',
      description:
        "Search the user's knowledge base for relevant documents and passages. Use this to retrieve information from previously uploaded files, PDFs, or documents.",
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query to find relevant knowledge' },
          limit: { type: 'number', description: 'Maximum number of results to return (default: 5)' },
        },
        required: ['query'],
      },
      cost: 0,
    },
  ],
  [
    'github_api',
    {
      name: 'github_api',
      description:
        "Call the GitHub REST API using the user's connected GitHub account. Supports any GitHub API endpoint. Use for creating issues, listing repos, managing PRs, etc.",
      parameters: {
        type: 'object',
        properties: {
          method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], description: 'HTTP method' },
          endpoint: { type: 'string', description: 'API endpoint path (e.g. /repos/owner/repo/issues)' },
          body: { type: 'object', description: 'Request body for POST/PUT/PATCH requests' },
        },
        required: ['method', 'endpoint'],
      },
      cost: 0,
    },
  ],
  [
    'linear_api',
    {
      name: 'linear_api',
      description:
        "Query the Linear GraphQL API using the user's connected Linear account. Use for creating issues, listing projects, managing cycles, etc.",
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'GraphQL query string' },
          variables: { type: 'object', description: 'GraphQL variables' },
        },
        required: ['query'],
      },
      cost: 0,
    },
  ],
  [
    'notion_api',
    {
      name: 'notion_api',
      description:
        "Call the Notion API using the user's connected Notion account. Use for searching pages, querying databases, creating pages, etc.",
      parameters: {
        type: 'object',
        properties: {
          method: { type: 'string', enum: ['GET', 'POST', 'PATCH', 'DELETE'], description: 'HTTP method' },
          endpoint: { type: 'string', description: 'API endpoint path (e.g. /v1/search, /v1/pages)' },
          body: { type: 'object', description: 'Request body for POST/PATCH requests' },
        },
        required: ['method', 'endpoint'],
      },
      cost: 0,
    },
  ],
]);

// ── Schema builders ──

const toOpenAITool = (name: string, description: string, parameters: ToolParameters): OpenAI.ChatCompletionTool => ({
  type: 'function',
  function: { name, description, parameters },
});

const toAnthropicTool = (name: string, description: string, parameters: ToolParameters): Anthropic.Tool => ({
  name,
  description,
  input_schema: {
    type: 'object',
    ...(parameters as Record<string, unknown>),
  },
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

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

  if (typeof schema['description'] === 'string') converted['description'] = schema['description'];
  if (Array.isArray(schema['enum'])) converted['enum'] = schema['enum'];
  if (Array.isArray(schema['required'])) converted['required'] = schema['required'];

  if (isRecord(schema['properties'])) {
    converted['properties'] = Object.fromEntries(
      Object.entries(schema['properties']).map(([key, value]) => [key, toGoogleSchema(value)])
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
      return [
        {
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters as ToolParameters,
        },
      ];
    }

    if (!BUILTIN_TOOL_NAMES.has(tool.type as Exclude<Tool['type'], 'function'>)) return [];
    const definition = CANONICAL_TOOL_DEFS.get(tool.type as Exclude<Tool['type'], 'function'>);
    return definition
      ? [{ name: definition.name, description: definition.description, parameters: definition.parameters }]
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
  return [
    { functionDeclarations: specs.map((spec) => toGoogleDeclaration(spec.name, spec.description, spec.parameters)) },
  ];
};
