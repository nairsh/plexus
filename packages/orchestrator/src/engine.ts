import { WorkflowError } from '@orchestrator/shared';
import type { OrchestratorTask, WorkflowConfig, WorkflowEvent } from '@orchestrator/shared';
import { getWorkflowTrace } from './orchestrator/tracing.js';
import { runWorkflow } from './orchestrator/loop.js';
export { runWorkflow } from './orchestrator/loop.js';
import { emitWorkflowEvent, getWorkflowEmitter } from './workflow/emitter.js';
import {
  getWorkflowDetails,
  getWorkflowSummaryById,
  hydrateWorkflowState,
  insertWorkflow,
  listWorkflows,
  persistWorkflowCancellation,
  persistWorkflowStatus,
  toPublicTask,
  updateWorkflowObjectiveForContinuation,
} from './workflow/persistence.js';
import {
  createWorkflowState,
  type TaskSummary,
  type WorkflowState,
  type WorkflowStatus,
  type WorkflowStreamIterator,
  type WorkflowSummary,
  workflows,
} from './workflow/state.js';
import { cleanupSessions } from './subagents/lifecycle.js';
import { recordStep } from './orchestrator/tracing.js';
import { resolveOrchestratorModel } from '@orchestrator/model-router';
import { listWorkItems } from './workItems.js';

export async function planWorkflow(
  userId: string,
  config: WorkflowConfig,
): Promise<{ workflowId: string; tasks: OrchestratorTask[] }> {
  const workflowId = crypto.randomUUID();
  const orchestratorModel = resolveOrchestratorModel(config.orchestrator_model ?? config.model_overrides?.orchestrator);

  insertWorkflow(workflowId, userId, config, orchestratorModel);

  const state = createWorkflowState({
    id: workflowId,
    userId,
    config,
    orchestratorModel,
    status: 'executing',
  });

  workflows.set(workflowId, state);

  recordStep(state, {
    step_type: 'orchestrator_message',
    model_name: orchestratorModel,
    message_content: `Workflow created: ${config.objective}`,
    tool_name: null,
    tool_input: null,
    tool_output: null,
    subagent_id: 'orchestrator',
  });

  return {
    workflowId,
    tasks: listWorkItems(workflowId).map(toPublicTask),
  };
}

export function executeWorkflow(workflowId: string): WorkflowStreamIterator {
  const state = hydrateWorkflowState(workflowId);
  if (!state) {
    throw new WorkflowError(`Workflow not found: ${workflowId}`);
  }

  if (!state.executionPromise && state.status !== 'executing') {
    const terminalEvents: WorkflowEvent[] = [];
    if (state.status === 'completed') {
      terminalEvents.push({
        type: 'workflow_completed',
        workflow_id: workflowId,
        data: { output: state.lastOutput ?? '', total_credits: state.creditsConsumed },
        timestamp: new Date().toISOString(),
      });
    } else if (state.status === 'failed' || state.status === 'cancelled') {
      terminalEvents.push({
        type: 'workflow_failed',
        workflow_id: workflowId,
        data: { error: state.status === 'cancelled' ? 'Workflow cancelled' : 'Workflow failed' },
        timestamp: new Date().toISOString(),
      });
    }

    const iterator: AsyncIterable<WorkflowEvent> = {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<WorkflowEvent>> {
            if (terminalEvents.length > 0) {
              return Promise.resolve({ value: terminalEvents.shift()!, done: false });
            }
            return Promise.resolve({ value: undefined as never, done: true });
          },
        };
      },
    };

    return {
      ...iterator,
      done: Promise.resolve(),
    };
  }

  const eventQueue: WorkflowEvent[] = [];
  let resolveWaiter: (() => void) | null = null;
  let streamDone = false;

  const listener = (event: WorkflowEvent) => {
    eventQueue.push(event);
    if (resolveWaiter) {
      resolveWaiter();
      resolveWaiter = null;
    }
  };

  state.emitter.on('event', listener);

  const runPromise = (state.executionPromise ??= runWorkflow(state.userId, state.config, workflowId)
    .then((result) => {
      state.lastOutput = result.output;
    })
    .finally(() => {
      state.executionPromise = undefined;
      streamDone = true;
      if (resolveWaiter) {
        resolveWaiter();
        resolveWaiter = null;
      }
    }));

  const iterator: AsyncIterable<WorkflowEvent> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<WorkflowEvent>> {
          while (eventQueue.length === 0 && !streamDone) {
            await new Promise<void>((resolve) => {
              resolveWaiter = resolve;
            });
          }

          if (eventQueue.length > 0) {
            const value = eventQueue.shift()!;
            return { value, done: false };
          }

          state.emitter.off('event', listener);
          return { value: undefined as never, done: true };
        },
      };
    },
  };

  return {
    ...iterator,
    done: runPromise.then(() => undefined),
  };
}

export function executeWorkflowToCompletion(workflowId: string): Promise<void> {
  const stream = executeWorkflow(workflowId);
  return stream.done;
}

export function cancelWorkflow(workflowId: string): void {
  const state = hydrateWorkflowState(workflowId);
  if (!state) {
    throw new WorkflowError(`Workflow not found: ${workflowId}`);
  }

  state.abortController.abort();
  state.status = 'cancelled';
  persistWorkflowCancellation(workflowId);
  cleanupSessions(state);

  emitWorkflowEvent(state, {
    type: 'workflow_failed',
    workflow_id: workflowId,
    data: { error: 'Workflow cancelled by user' },
  });
}

export function resolveWorkflowApproval(
  workflowId: string,
  approvalId: string,
  decision: import('@orchestrator/shared').ToolApprovalDecision,
): void {
  const state = hydrateWorkflowState(workflowId);
  if (!state) {
    throw new WorkflowError(`Workflow not found: ${workflowId}`);
  }

  const pending = state.approvalState.pending.get(approvalId);
  if (!pending) {
    throw new WorkflowError(`Approval request not found: ${approvalId}`);
  }

  state.approvalState.pending.delete(approvalId);
  pending.resolve(decision);
}

export function getWorkflowState(workflowId: string): WorkflowState | null {
  return hydrateWorkflowState(workflowId);
}

export { getWorkflowEmitter, getWorkflowDetails, listWorkflows, getWorkflowTrace, getWorkflowSummaryById };
export type { WorkflowSummary, TaskSummary };

export async function continueWorkflow(
  workflowId: string,
  followUpQuery: string,
): Promise<{ workflowId: string; status: WorkflowStatus }> {
  const state = hydrateWorkflowState(workflowId);
  if (!state) {
    throw new WorkflowError(`Workflow not found: ${workflowId}`);
  }

  state.config = {
    ...state.config,
    objective: followUpQuery,
  };
  state.status = 'executing';
  state.abortController = new AbortController();

  state.messages.push({ role: 'user', content: followUpQuery });
  state.conversationHistory.push({
    role: 'user',
    content: followUpQuery,
    timestamp: new Date().toISOString(),
  });

  updateWorkflowObjectiveForContinuation(workflowId, followUpQuery);
  state.executionPromise = undefined;
  return { workflowId, status: 'executing' };
}

export function pauseWorkflow(workflowId: string): void {
  const state = hydrateWorkflowState(workflowId);
  if (!state) {
    throw new WorkflowError(`Workflow not found: ${workflowId}`);
  }
  if (state.status !== 'executing') {
    throw new WorkflowError(`Cannot pause workflow in status: ${state.status}`);
  }

  state.status = 'paused';
  persistWorkflowStatus(workflowId, 'paused');
}

export async function resumeWorkflow(
  workflowId: string,
  _approvals?: Array<{ task_id: string; approved: boolean; feedback?: string }>,
): Promise<void> {
  const state = hydrateWorkflowState(workflowId);
  if (!state) {
    throw new WorkflowError(`Workflow not found: ${workflowId}`);
  }
  if (state.status !== 'paused' && state.status !== 'completed' && state.status !== 'failed') {
    throw new WorkflowError(`Cannot resume workflow in status: ${state.status}`);
  }

  state.status = 'executing';
  state.abortController = new AbortController();
  persistWorkflowStatus(workflowId, 'executing');

  if (!state.executionPromise) {
    state.executionPromise = runWorkflow(state.userId, state.config, workflowId)
      .then((result) => {
        state.lastOutput = result.output;
      })
      .finally(() => {
        state.executionPromise = undefined;
      });
  }
}
