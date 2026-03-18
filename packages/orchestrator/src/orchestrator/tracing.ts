import type { ToolTraceHooks, WorkflowTraceStep } from '@orchestrator/shared';
import { getWorkflowTrace as readWorkflowTrace, logWorkflowStep } from '../workflowTrace.js';
import type { WorkflowState } from '../workflow/state.js';
import { emitWorkflowEvent } from '../workflow/emitter.js';

export const recordStep = (
  state: WorkflowState,
  step: Omit<WorkflowTraceStep, 'step_id' | 'workflow_id' | 'timestamp'> & { timestamp?: string }
): WorkflowTraceStep => {
  return logWorkflowStep({
    workflow_id: state.id,
    timestamp: step.timestamp,
    step_type: step.step_type,
    model_name: step.model_name,
    message_content: step.message_content,
    tool_name: step.tool_name,
    tool_input: step.tool_input,
    tool_output: step.tool_output,
    subagent_id: step.subagent_id,
  });
};

export const buildToolTraceHooks = (state: WorkflowState, subagentId: string, model?: string): ToolTraceHooks => ({
  model,
  workflow_id: state.id,
  subagent_id: subagentId,
  onToolCall: async (event) => {
    if (subagentId === 'orchestrator') {
      emitWorkflowEvent(state, {
        type: 'tool_call',
        workflow_id: state.id,
        data: { tool_name: event.name, tool_input: event.input },
      });
    } else {
      emitWorkflowEvent(state, {
        type: 'subagent_tool_call',
        workflow_id: state.id,
        task_id: event.subagent_id ?? subagentId,
        data: { tool_name: event.name, tool_input: event.input },
      });
    }
    recordStep(state, {
      step_type: subagentId === 'orchestrator' ? 'tool_call' : 'subagent_tool_call',
      model_name: event.model ?? model ?? null,
      message_content: null,
      tool_name: event.name,
      tool_input: event.input,
      tool_output: null,
      subagent_id: event.subagent_id ?? subagentId,
    });
  },
  onToolResult: async (event) => {
    if (subagentId === 'orchestrator') {
      emitWorkflowEvent(state, {
        type: 'tool_result',
        workflow_id: state.id,
        data: { tool_name: event.name, tool_output: event.output },
      });
    } else {
      emitWorkflowEvent(state, {
        type: 'subagent_tool_result',
        workflow_id: state.id,
        task_id: event.subagent_id ?? subagentId,
        data: { tool_name: event.name, tool_output: event.output },
      });
    }
    recordStep(state, {
      step_type: subagentId === 'orchestrator' ? 'tool_result' : 'subagent_tool_result',
      model_name: event.model ?? model ?? null,
      message_content: null,
      tool_name: event.name,
      tool_input: null,
      tool_output: event.output,
      subagent_id: event.subagent_id ?? subagentId,
    });
  },
  onToolApprovalRequest: async (event) => {
    if (state.config.human_approval !== true) {
      return 'approve';
    }

    if (state.approvalState.approveAllCommands) {
      return 'approve';
    }
    if (event.command_key && state.approvalState.approvedCommandKeys.has(event.command_key)) {
      return 'approve';
    }

    const approvalId = crypto.randomUUID();
    emitWorkflowEvent(state, {
      type: 'bash_approval_requested',
      workflow_id: state.id,
      task_id: subagentId === 'orchestrator' ? undefined : subagentId,
      data: {
        id: approvalId,
        tool_name: event.name,
        command:
          typeof (event.input as { command?: unknown } | undefined)?.command === 'string'
            ? (event.input as { command: string }).command
            : '',
        reason: event.reason,
        command_key: event.command_key,
        subagent_id: event.subagent_id ?? subagentId,
      },
    });

    const decision = await new Promise<import('@orchestrator/shared').ToolApprovalDecision>((resolve) => {
      state.approvalState.pending.set(approvalId, { resolve, commandKey: event.command_key });
    });

    if (decision === 'approve_all_session') {
      state.approvalState.approveAllCommands = true;
    }
    if (decision === 'approve_command_session' && event.command_key) {
      state.approvalState.approvedCommandKeys.add(event.command_key);
    }

    return decision;
  },
});

export const getWorkflowTrace = (workflowId: string): WorkflowTraceStep[] => readWorkflowTrace(workflowId);
