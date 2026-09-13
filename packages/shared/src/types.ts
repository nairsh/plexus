// ── Model Provider Adapter ──
export interface AgentRequest {
  model: string;
  input: string | ConversationMessage[];
  instructions?: string;
  tools?: Tool[];
  allowed_skills?: string[];
  tool_execution?: 'auto' | 'manual';
  max_output_tokens?: number;
  temperature?: number;
  stream?: boolean;
  reasoning?: { effort: 'low' | 'medium' | 'high' };
  text?: { format: { type: 'text' | 'json_schema'; json_schema?: object } };
  previous_response_id?: string;
  model_fallback?: string[];
  preset?: string;
  trace?: ToolTraceHooks;
  chat_id?: string;
  user_id?: string;
  working_directory?: string;
  signal?: AbortSignal;
}

export interface ToolTraceHooks {
  model?: string;
  workflow_id?: string;
  subagent_id?: string;
  onToolCall?: (event: ToolTraceEvent) => void | Promise<void>;
  onToolResult?: (event: ToolTraceResultEvent) => void | Promise<void>;
  onToolApprovalRequest?: (event: ToolApprovalRequestEvent) => Promise<ToolApprovalDecision> | ToolApprovalDecision;
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

export interface ToolApprovalRequestEvent extends ToolTraceEvent {
  reason: string;
  command_key?: string;
}

export type ToolApprovalDecision = 'approve' | 'approve_command_session' | 'approve_all_session' | 'deny';

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
  reasoning_tokens?: number;
  cached_input_tokens?: number;
  cost: {
    currency: 'USD';
    input_cost: number;
    output_cost: number;
    tool_calls_cost: number;
    total_cost: number;
  };
}

export type TaskOrigin = 'planned' | 'runtime_generated';

export interface TaskUsageSummary {
  model: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface TaskMetadata {
  origin: TaskOrigin;
  semantic_key?: string | null;
  output_artifact?: string | null;
  reason_generated?: string | null;
  supersedes_task_id?: string | null;
}

export interface SubagentExecutionResult {
  output: string;
  model: string;
  usage: UsageInfo;
}

/** Discriminated union of all output block shapes produced by tools and model adapters. */
export type OutputBlock =
  | { type: 'message'; content: string }
  | { type: 'reasoning'; content: string }
  | { type: 'tool_use'; id?: string; name: string; arguments: string | Record<string, unknown> }
  | { type: 'search_results'; [key: string]: unknown }
  | { type: 'fetch_url_results'; [key: string]: unknown }
  | { type: 'file_read_result'; [key: string]: unknown }
  | { type: 'file_write_result'; [key: string]: unknown }
  | { type: 'file_edit_result'; [key: string]: unknown }
  | { type: 'bash_result'; [key: string]: unknown }
  | { type: 'grep_result'; [key: string]: unknown }
  | { type: 'glob_result'; [key: string]: unknown };

export interface Tool {
  type:
    | 'web_search'
    | 'fetch_url'
    | 'function'
    | 'code_execution'
    | 'file_read'
    | 'file_write'
    | 'file_edit'
    | 'bash'
    | 'grep'
    | 'glob'
    | 'run_skill'
    | 'remember'
    | 'recall'
    | 'search_knowledge'
    | 'github_api'
    | 'linear_api'
    | 'notion_api';
  function?: { name: string; description: string; parameters: object };
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  prompt_addendum: string;
  tools?: Tool[];
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
  type:
    | 'text_delta'
    | 'reasoning_delta'
    | 'usage'
    | 'tool_use'
    | 'search_results'
    | 'done'
    | 'error'
    | 'model_fallback';
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
  working_directory?: string;
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
  working_directory?: string;
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

/** The type of specialized sub-agent that handles a task */
export type AgentType = 'research' | 'analyze' | 'write' | 'code' | 'file' | 'deep_research';

/** A single task in the orchestrator's task list */
export interface OrchestratorTask {
  task_id: string;
  description: string;
  agent_type: AgentType;
  depends_on: string[];
  status: 'pending' | 'running' | 'completed' | 'failed' | 'blocked' | 'cancelled' | 'skipped';
  origin?: TaskOrigin;
  semantic_key?: string | null;
  output_artifact?: string | null;
  reason_generated?: string | null;
  supersedes_task_id?: string | null;
}

export interface WorkflowConfig {
  objective: string;
  orchestrator_model?: string;
  chat_id?: string;
  model_overrides?: Record<string, string>;
  /** Explicit fallback model IDs to try (in order) if the primary model fails. */
  model_fallback?: string[];
  working_directory?: string;
  tools?: string[];
  max_credits?: number;
  callback_url?: string;
  /** HMAC secret for signing outbound webhook payloads. Requires `callback_url` to also be set. */
  webhook_secret?: string;
  human_approval?: boolean;
  context_files?: Array<{ filename: string; content_base64: string; media_type: string }>;
  background?: boolean;
  /** Optional team ID — when set, team settings and shared context are applied to the workflow */
  team_id?: string;
}

export type ConnectorProvider = 'github' | 'linear' | 'notion';

export type ConnectorStatus = 'pending' | 'connected' | 'error' | 'disconnected';

export interface ConnectorRecord {
  id: string;
  user_id: string;
  provider: ConnectorProvider;
  status: ConnectorStatus;
  display_name: string;
  scopes: string[];
  external_id: string | null;
  metadata: Record<string, unknown>;
  last_validated_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export type ScheduleType = 'cron' | 'interval';

export type ScheduleIntervalUnit = 'minutes' | 'hours' | 'days' | 'weeks' | 'months';

export type ScheduleOverlapPolicy = 'skip' | 'queue';

export interface ScheduledWorkflowRecord {
  id: string;
  user_id: string;
  cron_expression: string | null;
  schedule_type: ScheduleType;
  interval_value: number | null;
  interval_unit: ScheduleIntervalUnit | null;
  timezone: string;
  overlap_policy: ScheduleOverlapPolicy;
  start_at: string | null;
  end_at: string | null;
  workflow_config: string;
  status: 'active' | 'paused' | 'deleted' | string;
  last_run_at: string | null;
  next_run_at: string | null;
  run_count: number;
  active_workflow_id: string | null;
  last_run_status: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeDocument {
  id: string;
  user_id: string;
  filename: string;
  media_type: string;
  source_type: 'upload';
  status: 'processing' | 'ready' | 'failed';
  extraction_mode: 'text' | 'ocr' | 'document';
  byte_size: number;
  chunk_count: number;
  summary: string | null;
  metadata: Record<string, unknown>;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeChunk {
  id: string;
  document_id: string;
  user_id: string;
  chunk_index: number;
  content: string;
  embedding_model: string;
  embedding: number[];
  metadata: Record<string, unknown>;
  created_at: string;
}

/** @deprecated Use OrchestratorTask — kept for backward compatibility with stored workflows */
export interface DAGPlan {
  tasks: DAGTask[];
}

/** @deprecated Use OrchestratorTask — kept for backward compatibility with stored workflows */
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
    | 'tasks_initialized'
    | 'orchestrator_thinking'
    | 'tool_call'
    | 'tool_result'
    | 'task_started'
    | 'task_dispatched'
    | 'task_completed'
    | 'task_failed'
    | 'task_added'
    | 'task_reused'
    | 'task_skipped'
    | 'human_approval_required'
    | 'workflow_completed'
    | 'workflow_failed'
    | 'workflow_cancelled'
    | 'credit_update'
    | 'subagent_tool_call'
    | 'subagent_tool_result'
    | 'bash_approval_requested'
    | 'clarification_requested'
    | 'workflow_progress'
    | 'team_created'
    | 'team_message_sent'
    | 'team_dissolved';
  workflow_id: string;
  task_id?: string;
  data: unknown;
  timestamp: string;
}

export interface OrchestratorThinkingData {
  thinking: string;
  iteration: number;
  mode?: 'llm' | 'stream' | 'response';
}

export interface WorkflowTaskPlanEntry {
  id: string;
  description: string;
  agent_type: AgentType;
  depends_on: string[];
  status?: OrchestratorTask['status'];
  origin?: TaskOrigin;
  output_artifact?: string | null;
  reason_generated?: string | null;
  supersedes_task_id?: string | null;
}

export type WorkflowStepType =
  | 'orchestrator_message'
  | 'tool_call'
  | 'tool_result'
  | 'subagent_spawn'
  | 'subagent_message'
  | 'subagent_tool_call'
  | 'subagent_tool_result'
  | 'system_event'
  | 'orchestrator_thinking';

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

// ── Enhanced Subagent Types ──

export interface SubagentProgress {
  iteration: number;
  maxIterations: number;
  phase: 'analyzing' | 'implementing' | 'testing' | 'fixing' | 'complete';
  summary: string;
  filesModified: string[];
  errorsFound: number;
  errorsFixed: number;
}

export interface LintResult {
  language: string;
  filePath: string;
  errors: LintError[];
  warnings: LintError[];
}

export interface LintError {
  line: number;
  column: number;
  severity: 'error' | 'warning';
  message: string;
  rule?: string;
}

export interface FileReadCache {
  path: string;
  content: string;
  readAt: number;
}

// ── Teams (beta) ──

export interface Team {
  id: string;
  name: string;
  owner_id: string;
  settings: TeamSettings;
  created_at: string;
  updated_at: string;
}

export interface TeamMember {
  team_id: string;
  user_id: string;
  role: 'owner' | 'admin' | 'member';
  joined_at: string;
}

export interface TeamSettings {
  shared_model_overrides?: Record<string, string>;
  shared_tools?: string[];
  shared_instructions?: string;
  max_credits_per_workflow?: number;
  require_approval_for_bash?: boolean;
  allowed_agent_types?: AgentType[];
  feature_flags?: Record<string, boolean>;
}

export interface TeamSharedContext {
  id: string;
  team_id: string;
  name: string;
  content: string;
  content_type: 'instructions' | 'knowledge' | 'template';
  created_by: string;
  created_at: string;
  updated_at: string;
}

// ── Git Sandbox / Rollback ──

export interface GitSandbox {
  id: string;
  workflow_id: string;
  workspace_path: string;
  branch_name: string;
  base_commit: string;
  status: 'active' | 'committed' | 'rolled_back';
  created_at: string;
  files_changed: string[];
}

// ── File Upload ──

export interface FileUpload {
  id: string;
  workflow_id: string;
  filename: string;
  content_base64: string;
  media_type: string;
  size_bytes: number;
  uploaded_at: string;
}

// ── Workflow Templates ──

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  config: Omit<WorkflowConfig, 'objective'>;
  created_by: string;
  is_public: boolean;
  tags: string[];
  created_at: string;
  usage_count: number;
}

// ── Agent Health ──

export interface AgentHealthStatus {
  agent_type: AgentType;
  model: string;
  status: 'healthy' | 'degraded' | 'unavailable';
  last_success_at: string | null;
  last_failure_at: string | null;
  success_rate_1h: number;
  avg_latency_ms: number;
}

// ── Extended Workflow Events ──
export type ExtendedWorkflowEventType =
  | WorkflowEvent['type']
  | 'subagent_progress'
  | 'lint_result'
  | 'file_upload'
  | 'git_snapshot'
  | 'git_rollback'
  | 'health_check';
