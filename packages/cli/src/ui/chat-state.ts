import type { WorkflowTraceStep } from '@orchestrator/shared';

export interface WorkflowHistoryItem {
  id: string;
  objective: string;
  status: string;
  updated_at: string;
  created_at: string;
}

export type ToolExecutionStatus = 'running' | 'done' | 'error';

export interface SubagentStep {
  id: string;
  toolName: string;
  input: unknown;
  output?: unknown;
  status: ToolExecutionStatus;
}

export interface ApprovalRequestState {
  id: string;
  title: string;
  subtitle: string;
  command: string;
}

export type TranscriptEntry =
  | { id: string; type: 'user'; text: string }
  | { id: string; type: 'assistant'; text: string }
  | { id: string; type: 'system'; text: string; tone?: 'muted' | 'error' | 'success' }
  | {
      id: string;
      type: 'tool';
      toolName: string;
      input: unknown;
      output?: unknown;
      status: ToolExecutionStatus;
      source: 'orchestrator' | 'subagent';
    }
  | {
      id: string;
      type: 'subagent';
      taskId: string;
      agentType: string;
      title: string;
      description: string;
      status: 'running' | 'done' | 'error';
      steps: SubagentStep[];
      startedAt: number;
      usageTokens?: number;
      toolUses: number;
      durationMs?: number;
      error?: string;
      model?: string;
    };

export type MenuState =
  | { type: 'model' }
  | { type: 'continue'; options: WorkflowHistoryItem[] }
  | { type: 'approval'; request: ApprovalRequestState }
  | null;

export interface LoadedWorkflowState {
  workflow: WorkflowHistoryItem;
  trace: WorkflowTraceStep[];
}

export interface ChatScreenState {
  transcript: TranscriptEntry[];
  busy: boolean;
  inputUnlocked: boolean;
  workflowId: string | null;
  scrollOffset: number;
  statusStartedAt: number | null;
  totalTokensTarget: number;
  totalTokensDisplay: number;
  currentModel: string;
  menu: MenuState;
  thinkingText: string;
  thinkingActive: boolean;
  statusMessage: string;
  currentQuip: string;
}

export const createInitialState = (currentModel: string): ChatScreenState => ({
  transcript: [],
  busy: false,
  inputUnlocked: false,
  workflowId: null,
  scrollOffset: 0,
  statusStartedAt: null,
  totalTokensTarget: 0,
  totalTokensDisplay: 0,
  currentModel,
  menu: null,
  thinkingText: '',
  thinkingActive: false,
  statusMessage: '',
  currentQuip: 'Working',
});

export const createEntryId = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
