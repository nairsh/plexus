// ── Model Provider Adapter ──
export interface AgentRequest {
  model: string;
  input: string | ConversationMessage[];
  instructions?: string;
  tools?: Tool[];
  max_output_tokens?: number;
  temperature?: number;
  stream?: boolean;
  reasoning?: { effort: 'low' | 'medium' | 'high' };
  text?: { format: { type: 'text' | 'json_schema'; json_schema?: object } };
  previous_response_id?: string;
  model_fallback?: string[];
  preset?: string;
  trace?: ToolTraceHooks;
}

export interface ToolTraceHooks {
  model?: string;
  workflow_id?: string;
  subagent_id?: string;
  onToolCall?: (event: ToolTraceEvent) => void | Promise<void>;
  onToolResult?: (event: ToolTraceResultEvent) => void | Promise<void>;
}

export interface ToolTraceEvent {
  name: string;
  input: unknown;
  model?: string;
  workflow_id?: string;
  subagent_id?: string;
}

export interface ToolTraceResultEvent extends ToolTraceEvent {
  output: unknown;
}

export interface AgentResponse {
  id: string;
  model: string;
  status: 'completed' | 'failed' | 'incomplete';
  output: OutputBlock[];
  output_text: string;
  usage: UsageInfo;
  tools: Tool[];
  created_at: number;
  completed_at: number;
}

export interface UsageInfo {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost: {
    currency: 'USD';
    input_cost: number;
    output_cost: number;
    tool_calls_cost: number;
    total_cost: number;
  };
}

export interface OutputBlock {
  type: 'search_results' | 'fetch_url_results' | 'message';
  [key: string]: unknown;
}

export interface Tool {
  type: 'web_search' | 'fetch_url' | 'function' | 'code_execution';
  function?: { name: string; description: string; parameters: object };
}

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | ContentBlock[];
}

export interface ContentBlock {
  type: 'text' | 'image' | 'document';
  text?: string;
  source?: { type: 'base64'; media_type: string; data: string };
}

// ── Model Provider Adapter Interface ──
export interface ModelAdapter {
  readonly provider: string;
  createResponse(request: AgentRequest): Promise<AgentResponse>;
  streamResponse(request: AgentRequest): AsyncIterable<StreamChunk>;
  listModels(): Promise<ModelInfo[]>;
}

export interface StreamChunk {
  type: 'text_delta' | 'tool_use' | 'search_results' | 'done' | 'error';
  text?: string;
  data?: unknown;
}

export interface ModelInfo {
  id: string;
  provider: string;
  display_name: string;
  capabilities: string[];
  cost_per_1m_input: number;
  cost_per_1m_output: number;
  context_window: number;
  max_output_tokens: number;
}

// ── Sandbox ──
export interface SandboxConfig {
  language: 'python' | 'javascript' | 'sql';
  chat_id?: string;
  task_id?: string;
  timeout_seconds?: number;
  packages?: string[];
  files?: Array<{ path: string; content_base64: string }>;
}

export interface SandboxSession {
  id: string;
  status: 'creating' | 'ready' | 'executing' | 'terminated' | 'error';
  language: string;
  chat_id?: string;
  environment_status?: 'stopped' | 'starting' | 'running';
  workspace_path?: string;
  created_at: string;
}

export interface ExecutionResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  execution_time_ms: number;
  files_modified: string[];
}

// ── Orchestrator ──
export interface WorkflowConfig {
  objective: string;
  orchestrator_model?: string;
  chat_id?: string;
  model_overrides?: Record<string, string>;
  tools?: string[];
  max_credits?: number;
  callback_url?: string;
  human_approval?: boolean;
  context_files?: Array<{ filename: string; content_base64: string; media_type: string }>;
  background?: boolean;
}

export interface DAGPlan {
  tasks: DAGTask[];
}

export interface DAGTask {
  task_id: string;
  parent_task_ids: string[];
  task_type: string;
  description: string;
  model?: string | null;
  tools?: Tool[] | null;
  input_template: string;
}

export interface WorkflowEvent {
  type:
    | 'planning_complete'
    | 'task_started'
    | 'task_completed'
    | 'task_failed'
    | 'human_approval_required'
    | 'workflow_completed'
    | 'workflow_failed'
    | 'credit_update';
  workflow_id: string;
  task_id?: string;
  data: unknown;
  timestamp: string;
}

export type WorkflowStepType =
  | 'orchestrator_message'
  | 'tool_call'
  | 'tool_result'
  | 'subagent_spawn'
  | 'subagent_message'
  | 'subagent_tool_call'
  | 'subagent_tool_result'
  | 'system_event';

export interface WorkflowTraceStep {
  step_id: string;
  workflow_id: string;
  timestamp: string;
  step_type: WorkflowStepType;
  model_name: string | null;
  message_content: string | null;
  tool_name: string | null;
  tool_input: unknown;
  tool_output: unknown;
  subagent_id: string | null;
}

// ── Error format ──
export type APIErrorType =
  | 'authentication_error'
  | 'rate_limit_error'
  | 'invalid_request'
  | 'model_error'
  | 'sandbox_error'
  | 'workflow_error'
  | 'billing_error'
  | 'internal_error';

export interface APIError {
  error: {
    type: APIErrorType;
    message: string;
    code: string;
    param?: string;
    retry_after?: number;
  };
}

// ── Auth context ──
export interface AuthUser {
  id: string;
  email: string | null;
  tier: 'free' | 'pro' | 'max' | 'enterprise';
  credits_balance: number;
}

// ── Model Registry Row ──
export interface ModelRegistryRow {
  id: string;
  provider: string;
  display_name: string;
  capabilities: string;
  cost_per_1m_input: number;
  cost_per_1m_output: number;
  max_output_tokens: number | null;
  context_window: number | null;
  supports_streaming: number;
  supports_tools: number;
  status: string;
  fallback_models: string | null;
  updated_at: string;
}

// ── Preset ──
export interface Preset {
  model: string;
  tools: Tool[];
  max_output_tokens: number;
  instructions: string;
}
