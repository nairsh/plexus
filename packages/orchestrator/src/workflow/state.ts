import { EventEmitter } from 'node:events';
import type { ConversationMessage, WorkflowConfig } from '@orchestrator/shared';

export const MAX_TURNS = 120;

export interface WorkflowStreamIterator extends AsyncIterable<import('@orchestrator/shared').WorkflowEvent> {
  done: Promise<void>;
}

export type WorkflowStatus = 'pending' | 'executing' | 'paused' | 'completed' | 'failed' | 'cancelled';

export interface SubagentRun {
  runId: string;
  workItemId: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  completedAt?: string;
  output?: string;
  error?: string;
  promise: Promise<void>;
}

export interface WorkflowState {
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
  approvalState: {
    approveAllCommands: boolean;
    approvedCommandKeys: Set<string>;
    pending: Map<
      string,
      {
        resolve: (decision: import('@orchestrator/shared').ToolApprovalDecision) => void;
        commandKey?: string;
        command?: string;
        toolName?: string;
        subagentId?: string;
        requestedAt: string;
      }
    >;
  };
}

export interface WorkflowSummary {
  id: string;
  objective: string;
  user_prompt?: string;
  orchestrator_model?: string | null;
  status: string;
  error?: string | null;
  credits_consumed: number;
  started_at?: string | null;
  ended_at?: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  output?: string | null;
  pause_reason?: string | null;
  /** Set when workflow is paused because the orchestrator asked a clarification question */
  pending_clarification?: string | null;
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

export const workflows = new Map<string, WorkflowState>();

interface CreateWorkflowStateInput {
  id: string;
  userId: string;
  config: WorkflowConfig;
  orchestratorModel: string;
  status: WorkflowStatus;
  creditsConsumed?: number;
  lastOutput?: string;
  messages?: ConversationMessage[];
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string; timestamp: string }>;
}

export const createWorkflowState = (input: CreateWorkflowStateInput): WorkflowState => {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(100);

  return {
    id: input.id,
    userId: input.userId,
    config: input.config,
    orchestratorModel: input.orchestratorModel,
    status: input.status,
    lastOutput: input.lastOutput,
    emitter,
    abortController: new AbortController(),
    sandboxSessionIds: [],
    creditsConsumed: input.creditsConsumed ?? 0,
    messages: input.messages ?? [{ role: 'user', content: input.config.objective }],
    subagentRuns: new Map(),
    approvalState: {
      approveAllCommands: false,
      approvedCommandKeys: new Set(),
      pending: new Map(),
    },
    conversationHistory: input.conversationHistory ?? [
      { role: 'user', content: input.config.objective, timestamp: new Date().toISOString() },
    ],
  };
};
