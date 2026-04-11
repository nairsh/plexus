import { WorkflowError, getDb } from '@orchestrator/shared';
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
  countWorkflows,
  persistWorkflowCancellation,
  persistWorkflowSnapshot,
  persistWorkflowStatus,
  toPublicTask,
  updateWorkflowObjectiveForContinuation,
} from './workflow/persistence.js';
import {
  createWorkflowState,
  MAX_TURNS,
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

const startWorkflowExecution = (state: WorkflowState): void => {
  if (state.executionPromise) return;
  state.executionPromise = runWorkflow(state.userId, state.config, state.id)
    .then((r) => { state.lastOutput = r.output; })
    .finally(() => { state.executionPromise = undefined; });
};

export async function planWorkflow(
  userId: string,
  config: WorkflowConfig,
): Promise<{ workflowId: string; tasks: OrchestratorTask[] }> {
  const workflowId = crypto.randomUUID();
  const orchestratorModel = resolveOrchestratorModel(config.orchestrator_model ?? config.model_overrides?.orchestrator, userId);

  insertWorkflow(workflowId, userId, config, orchestratorModel);

  const state = createWorkflowState({
    id: workflowId,
    userId,
    config,
    orchestratorModel,
    status: 'executing',
  });

  workflows.set(workflowId, state);
  persistWorkflowSnapshot(state);

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
    } else if (state.status === 'failed') {
      terminalEvents.push({
        type: 'workflow_failed',
        workflow_id: workflowId,
        data: { error: 'Workflow failed' },
        timestamp: new Date().toISOString(),
      });
    } else if (state.status === 'cancelled') {
      terminalEvents.push({
        type: 'workflow_cancelled',
        workflow_id: workflowId,
        data: { reason: 'Workflow cancelled' },
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

  // Idempotent: already cancelled is a no-op
  if (state.status === 'cancelled') return;

  if (state.status === 'completed') {
    throw new WorkflowError(`Cannot cancel a completed workflow: ${workflowId}`);
  }

  state.abortController.abort();
  state.status = 'cancelled';
  persistWorkflowCancellation(workflowId);
  cleanupSessions(state);

  // Resolve pending approvals as denied — they cannot proceed after cancel
  for (const pending of state.approvalState.pending.values()) {
    pending.resolve('deny');
  }
  state.approvalState.pending.clear();

  emitWorkflowEvent(state, {
    type: 'workflow_cancelled',
    workflow_id: workflowId,
    data: { reason: 'Workflow cancelled by user' },
  });
}

export function deleteWorkflow(workflowId: string): void {
  const state = workflows.get(workflowId) ?? hydrateWorkflowState(workflowId);
  if (state) {
    state.abortController.abort();
    cleanupSessions(state);

    for (const pending of state.approvalState.pending.values()) {
      pending.resolve('deny');
    }
    state.approvalState.pending.clear();
    state.subagentRuns.clear();
    state.emitter.removeAllListeners();
    workflows.delete(workflowId);
  }

  const db = getDb();
  const row = db
    .prepare(`SELECT json_extract(config, '$.chat_id') AS chat_id FROM workflows WHERE id = ?`)
    .get(workflowId) as { chat_id: string | null } | undefined;
  const chatId = row?.chat_id?.trim() || workflowId;

  db.transaction(() => {
    db.prepare(
      `UPDATE sandbox_workspaces
       SET active_session_id = NULL, status = 'inactive', updated_at = datetime('now')
       WHERE active_session_id IN (
         SELECT id FROM sandbox_sessions WHERE task_id IN (SELECT id FROM tasks WHERE workflow_id = ?) OR chat_id = ?
       )`
    ).run(workflowId, chatId);

    db.prepare('DELETE FROM sandbox_sessions WHERE task_id IN (SELECT id FROM tasks WHERE workflow_id = ?) OR chat_id = ?').run(
      workflowId,
      chatId
    );

    db.prepare('DELETE FROM workflows WHERE id = ?').run(workflowId);
  })();
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

/** Abort all in-flight workflows. Used during graceful shutdown. */
export function abortAllWorkflows(): number {
  let aborted = 0;
  for (const [id, state] of workflows) {
    if (state.status === 'executing' || state.status === 'paused') {
      state.abortController.abort();
      aborted++;
      import('@orchestrator/shared').then(({ logger }) =>
        logger.info({ workflowId: id }, 'Workflow aborted during shutdown')
      );
    }
  }
  return aborted;
}

export { getWorkflowEmitter, getWorkflowDetails, listWorkflows, countWorkflows, getWorkflowTrace, getWorkflowSummaryById };
export type { WorkflowSummary, TaskSummary };

export function getWorkflowProgress(workflowId: string): {
  workflow_id: string;
  status: string;
  iteration: number;
  max_turns: number;
  credits_consumed: number;
  tasks: { total: number; completed: number; running: number; pending: number; failed: number };
  estimated_progress_pct: number;
} | null {
  const details = getWorkflowDetails(workflowId);
  if (!details) return null;

  const inMemory = workflows.get(workflowId);
  const tasks = details.tasks;
  const completed = tasks.filter((t) => t.status === 'completed' || t.status === 'skipped').length;
  const running = tasks.filter((t) => t.status === 'running').length;
  const failed = tasks.filter((t) => t.status === 'failed').length;
  const pending = tasks.filter((t) => t.status === 'pending' || t.status === 'blocked').length;
  const total = tasks.length;

  const estimatedPct = total > 0
    ? Math.round(((completed + running * 0.5) / total) * 100)
    : details.workflow.status === 'completed' ? 100 : 0;

  return {
    workflow_id: workflowId,
    status: details.workflow.status,
    iteration: 0, // iteration count not persisted; use SSE for real-time
    max_turns: MAX_TURNS,
    credits_consumed: inMemory?.creditsConsumed ?? details.workflow.credits_consumed,
    tasks: { total, completed, running, pending, failed },
    estimated_progress_pct: estimatedPct,
  };
}

export function getPendingApprovals(workflowId: string): Array<{
  approval_id: string;
  tool_name?: string;
  command?: string;
  subagent_id?: string;
  requested_at: string;
}> {
  const state = hydrateWorkflowState(workflowId);
  if (!state) return [];
  return Array.from(state.approvalState.pending.entries()).map(([approvalId, entry]) => ({
    approval_id: approvalId,
    tool_name: entry.toolName,
    command: entry.command,
    subagent_id: entry.subagentId,
    requested_at: entry.requestedAt,
  }));
}

export function continueWorkflow(
  workflowId: string,
  followUpQuery: string,
): { workflowId: string; status: WorkflowStatus } {
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
  // Clear any pending clarification question now that user has responded
  persistWorkflowStatus(workflowId, 'executing');
  // Durably persist the full conversational state so crash recovery and
  // subsequent hydrations see the follow-up context.
  persistWorkflowSnapshot(state);
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
  persistWorkflowSnapshot(state);
}

/**
 * Retry a failed or cancelled workflow.
 * Resets non-terminal tasks back to pending so the loop can re-attempt them.
 * Completed and skipped tasks are preserved.
 *
 * NOTE: Running tasks must also be reset. When a workflow fails
 * (via persistWorkflowFailure), running tasks are NOT cascaded — unlike
 * cancel which sets pending/running → cancelled. Those orphaned running
 * tasks have no backing process after workflow failure and would be stuck
 * forever without this reset.
 */
export function retryWorkflow(workflowId: string): { workflowId: string; resetTasks: number } {
  const state = hydrateWorkflowState(workflowId);
  if (!state) throw new WorkflowError(`Workflow not found: ${workflowId}`);
  if (state.status !== 'failed' && state.status !== 'cancelled') {
    throw new WorkflowError(`Can only retry failed or cancelled workflows, current status: ${state.status}`);
  }

  // Reset failed/cancelled/running tasks to pending in DB.
  // Running tasks are included because persistWorkflowFailure does NOT
  // cascade to tasks — a task can legitimately be 'running' when a
  // workflow enters 'failed' state.
  const db = getDb();
  const result = db.prepare(`
    UPDATE tasks
    SET status = 'pending', output = NULL, completed_at = NULL, updated_at = datetime('now')
    WHERE workflow_id = ? AND status IN ('failed', 'cancelled', 'running')
  `).run(workflowId);

  const resetTasks = result.changes;

  state.status = 'executing';
  state.abortController = new AbortController();
  persistWorkflowStatus(workflowId, 'executing');
  persistWorkflowSnapshot(state);
  startWorkflowExecution(state);

  return { workflowId, resetTasks };
}

export function resumeWorkflow(
  workflowId: string,
  _approvals?: Array<{ task_id: string; approved: boolean; feedback?: string }>,
): void {
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
  persistWorkflowSnapshot(state);
  startWorkflowExecution(state);
}
