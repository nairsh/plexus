import type { WorkflowEvent } from '@orchestrator/shared';
import { hydrateWorkflowState } from './persistence.js';
import type { WorkflowState } from './state.js';

export const emitWorkflowEvent = (state: WorkflowState, event: Omit<WorkflowEvent, 'timestamp'>): void => {
  const full: WorkflowEvent = {
    ...event,
    timestamp: new Date().toISOString(),
  };
  state.emitter.emit('event', full);
};

export const getWorkflowEmitter = (workflowId: string) => hydrateWorkflowState(workflowId)?.emitter ?? null;
