import { terminateSession } from '@orchestrator/sandbox';
import { getErrorMessage, logger } from '@orchestrator/shared';
import { emitWorkflowEvent } from '../workflow/emitter.js';
import { persistWorkflowCompletion, persistWorkflowFailure } from '../workflow/persistence.js';
import type { WorkflowState } from '../workflow/state.js';
import { recordStep } from '../orchestrator/tracing.js';

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

  persistWorkflowCompletion(state);

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
};
