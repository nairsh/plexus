// Mirror of WorkflowEvent types from @orchestrator/shared
// Kept as standalone to avoid importing from workspace packages

export type WorkflowEventType =
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
  | 'credit_update'
  | 'subagent_tool_call'
  | 'subagent_tool_result'
  | 'bash_approval_requested';

export interface WorkflowEvent {
  type: WorkflowEventType;
  workflow_id: string;
  task_id?: string;
  data: unknown;
  timestamp: string;
}

export type AgentType = 'research' | 'analyze' | 'write' | 'code' | 'file' | 'deep_research';

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'blocked' | 'cancelled' | 'skipped';

export type WorkflowStatus = 'pending' | 'planning' | 'executing' | 'completed' | 'failed' | 'cancelled' | 'paused';

export interface WorkflowTask {
  id: string;
  description: string;
  agent_type: AgentType;
  depends_on: string[];
  status: TaskStatus;
  origin?: string;
  output_artifact?: string | null;
}

export interface Workflow {
  id: string;
  objective: string;
  status: WorkflowStatus;
  created_at: string;
  updated_at: string;
  tasks?: WorkflowTask[];
  output?: string;
  error?: string;
}

// Data shapes for specific event types
export interface TaskStartedData {
  description: string;
  display_description?: string;
  agent_type?: string;
  task_type?: string;
  origin?: string;
  output_artifact?: string;
  model?: string;
}

export interface TaskAddedData {
  description: string;
  display_description?: string;
  agent_type: string;
  depends_on?: string[];
  origin?: string;
  output_artifact?: string;
}

export interface ToolEventData {
  tool_name: string;
  tool_input?: unknown;
  tool_output?: unknown;
}

export interface TaskCompletedData {
  output_preview?: string;
  usage?: {
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
    model?: string;
  };
  output_line_count?: number;
  output_word_count?: number;
}

export interface TasksInitializedData {
  tasks: WorkflowTask[];
}

export interface WorkflowCompletedData {
  output?: string;
  total_credits?: number;
}

export interface WorkflowFailedData {
  error?: string;
}

export interface CreateWorkflowResponse {
  workflow_id: string;
  status: string;
  created_at: string;
  task_count: number;
  tasks: WorkflowTask[];
}
