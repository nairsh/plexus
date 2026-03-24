import { terminateSession } from '@orchestrator/sandbox';
import { getErrorMessage, logger } from '@orchestrator/shared';
import { emitWorkflowEvent } from '../workflow/emitter.js';
import { persistWorkflowCompletion, persistWorkflowFailure } from '../workflow/persistence.js';
import type { WorkflowState } from '../workflow/state.js';
import { workflows } from '../workflow/state.js';
import { recordStep } from '../orchestrator/tracing.js';

const MAX_WEBHOOK_RETRIES = 3;
const WEBHOOK_BACKOFF_BASE_MS = 1000;

async function fireWebhook(
  workflowId: string,
  callbackUrl: string,
  payload: Record<string, unknown>
): Promise<void> {
  for (let attempt = 0; attempt <= MAX_WEBHOOK_RETRIES; attempt++) {
    try {
      const res = await fetch(callbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok || (res.status < 500 && res.status !== 429)) {
        logger.info({ workflowId, callbackUrl, status: res.status, attempt }, 'Webhook callback delivered');
        return;
      }
      // Server error or rate limit — retry with backoff
      if (attempt < MAX_WEBHOOK_RETRIES) {
        const delay = WEBHOOK_BACKOFF_BASE_MS * Math.pow(2, attempt);
        logger.warn({ workflowId, callbackUrl, status: res.status, attempt, retryInMs: delay }, 'Webhook server error, retrying');
        await new Promise((r) => setTimeout(r, delay));
      } else {
        logger.warn({ workflowId, callbackUrl, status: res.status }, 'Webhook delivery failed after retries');
      }
    } catch (err) {
      if (attempt < MAX_WEBHOOK_RETRIES) {
        const delay = WEBHOOK_BACKOFF_BASE_MS * Math.pow(2, attempt);
        logger.warn({ workflowId, callbackUrl, error: getErrorMessage(err), attempt, retryInMs: delay }, 'Webhook callback error, retrying');
        await new Promise((r) => setTimeout(r, delay));
      } else {
        logger.warn({ workflowId, callbackUrl, error: getErrorMessage(err) }, 'Webhook callback failed after retries (non-critical)');
      }
    }
  }
}

const WORKFLOW_STATE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const scheduleStateCleanup = (workflowId: string, state: WorkflowState): void => {
  setTimeout(() => {
    // Guard: only evict if the map still holds the exact same state reference
    // AND the workflow is in a terminal state. A resumed/continued workflow
    // replaces the reference, so the old timer must not evict the new active state.
    const current = workflows.get(workflowId);
    if (current === state && (state.status === 'completed' || state.status === 'failed' || state.status === 'cancelled')) {
      workflows.delete(workflowId);
      logger.debug({ workflowId }, 'Cleaned up in-memory workflow state after TTL');
    }
  }, WORKFLOW_STATE_TTL_MS);
};

export const cleanupSessions = (state: WorkflowState): void => {
  for (const sessionId of state.sandboxSessionIds) {
    try {
      terminateSession(sessionId);
    } catch (error) {
      logger.warn(
        { workflowId: state.id, sessionId, error: getErrorMessage(error) },
        'Failed to terminate sandbox session'
      );
    }
  }
  state.sandboxSessionIds.length = 0;
};

export const completeWorkflow = (state: WorkflowState, output: string): void => {
  state.status = 'completed';
  state.lastOutput = output;

  persistWorkflowCompletion(state, output);

  recordStep(state, {
    step_type: 'system_event',
    model_name: state.orchestratorModel,
    message_content: 'workflow_completed',
    tool_name: null,
    tool_input: null,
    tool_output: { output: output.substring(0, 1000), total_credits: state.creditsConsumed },
    subagent_id: 'orchestrator',
  });

  emitWorkflowEvent(state, {
    type: 'workflow_completed',
    workflow_id: state.id,
    data: { output, total_credits: state.creditsConsumed },
  });

  cleanupSessions(state);
  scheduleStateCleanup(state.id, state);

  if (state.config.callback_url) {
    void fireWebhook(state.id, state.config.callback_url, {
      workflow_id: state.id,
      status: 'completed',
      output,
      total_credits: state.creditsConsumed,
    });
  }
};

export const failWorkflow = async (state: WorkflowState, message: string): Promise<void> => {
  state.status = 'failed';
  persistWorkflowFailure(state, message);

  emitWorkflowEvent(state, {
    type: 'workflow_failed',
    workflow_id: state.id,
    data: { error: message },
  });

  cleanupSessions(state);
  scheduleStateCleanup(state.id, state);

  if (state.config.callback_url) {
    void fireWebhook(state.id, state.config.callback_url, {
      workflow_id: state.id,
      status: 'failed',
      error: message,
      total_credits: state.creditsConsumed,
    });
  }
};
