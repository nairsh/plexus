import { debitCredits } from '@orchestrator/billing';
import { dispatchToAgent, getAgentModel } from '../agents.js';
import type { AgentExecutionContext } from '../agents.js';
import { getWorkItem, getWorkItemDisplayId, listWorkItems, updateWorkItem, type WorkItem } from '../workItems.js';
import { getErrorMessage } from '@orchestrator/shared';
import { emitWorkflowEvent } from '../workflow/emitter.js';
import { incrementWorkflowCredits } from '../workflow/persistence.js';
import type { SubagentRun, WorkflowState } from '../workflow/state.js';
import { buildToolTraceHooks, recordStep } from '../orchestrator/tracing.js';

export const waitForRuns = async (
  state: WorkflowState,
  todoIds?: string[],
  timeoutSeconds = 30,
): Promise<{
  completed: string[];
  running: string[];
  failed: Array<{ todo_id: string; error: string }>;
  completed_results: Array<ReturnType<typeof getSubagentResult>>;
}> => {
  const ids = todoIds ?? Array.from(state.subagentRuns.keys());
  const deadline = Date.now() + timeoutSeconds * 1000;

  const completed: string[] = [];
  const running: string[] = [];
  const failed: Array<{ todo_id: string; error: string }> = [];
  const completedResults: Array<ReturnType<typeof getSubagentResult>> = [];

  for (const id of ids) {
    const run = state.subagentRuns.get(id);
    if (!run) continue;

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      running.push(id);
      continue;
    }

    try {
      await Promise.race([
        run.promise,
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), remaining)),
      ]);

      if (run.status === 'completed') {
        completed.push(id);
        const result = getSubagentResult(state, id);
        if (result) {
          completedResults.push(result);
        }
      } else if (run.status === 'failed') {
        failed.push({ todo_id: id, error: run.error ?? 'Unknown error' });
      } else {
        running.push(id);
      }
    } catch (err) {
      logger.warn({ workflowId: state.id, todoId: id, error: getErrorMessage(err) }, 'Subagent wait timed out or failed');
      running.push(id);
    }
  }

  return { completed, running, failed, completed_results: completedResults };
};

export const buildAgentTaskPrompt = (state: WorkflowState, item: WorkItem): string => {
  const lines = [`Task: ${item.description}`];

  if (item.dependsOn.length > 0) {
    lines.push(`\nDependencies: ${item.dependsOn.map((depId) => getWorkItemDisplayId(state.id, depId)).join(', ')}`);
  }

  if (item.metadata.output_artifact) {
    lines.push(`\nExpected output: ${item.metadata.output_artifact}`);
  }

  lines.push(`\nObjective context: ${state.config.objective}`);

  return lines.join('\n');
};

export const buildAgentContext = (state: WorkflowState, taskId: string): AgentExecutionContext => ({
  workflowId: state.id,
  userId: state.userId,
  orchestratorModel: state.orchestratorModel,
  config: state.config,
  sandboxSessionIds: state.sandboxSessionIds,
  abortSignal: state.abortController.signal,
  creditsCallback: (amount: number, description: string) => {
    try {
      debitCredits(state.userId, amount, description, 'subagent', state.id);
      incrementWorkflowCredits(state, amount);
    } catch (err) {
      logger.warn({ workflowId: state.id, error: getErrorMessage(err) }, 'Failed to debit credits for subagent (non-critical)');
    }
  },
  trace: buildToolTraceHooks(state, taskId),
});

export const spawnSubagentRun = async (
  state: WorkflowState,
  item: WorkItem,
  promptOverride?: string,
  displayDescription?: string,
): Promise<SubagentRun> => {
  const existingRun = state.subagentRuns.get(item.id);
  if (existingRun && existingRun.status === 'running') {
    return existingRun;
  }

  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();

  updateWorkItem({ workflowId: state.id, itemId: item.id, status: 'running' });

  recordStep(state, {
    step_type: 'subagent_spawn',
    model_name: null,
    message_content: item.description,
    tool_name: null,
    tool_input: { agent_type: item.agentType, depends_on: item.dependsOn, run_id: runId },
    tool_output: null,
    subagent_id: item.id,
  });

  emitWorkflowEvent(state, {
    type: 'task_dispatched',
    workflow_id: state.id,
    task_id: item.id,
    data: { run_id: runId, agent_type: item.agentType },
  });

  emitWorkflowEvent(state, {
    type: 'task_started',
    workflow_id: state.id,
    task_id: item.id,
    data: {
      description: item.description,
      display_description: displayDescription ?? item.description,
      task_type: item.agentType,
      agent_type: item.agentType,
      origin: item.metadata.origin,
      output_artifact: item.metadata.output_artifact,
      run_id: runId,
      model: getAgentModel(item.agentType),
    },
  });

  const prompt = promptOverride ?? buildAgentTaskPrompt(state, item);
  const agentCtx = buildAgentContext(state, item.id);

  const promise = (async () => {
    try {
      const result = await dispatchToAgent(
        {
          task_id: item.id,
          description: item.description,
          agent_type: item.agentType,
          depends_on: item.dependsOn,
          status: 'running',
          origin: item.metadata.origin,
          semantic_key: item.metadata.semantic_key,
          output_artifact: item.metadata.output_artifact,
          reason_generated: item.metadata.reason_generated,
          supersedes_task_id: item.metadata.supersedes_task_id,
        },
        prompt,
        agentCtx,
      );

      updateWorkItem({ workflowId: state.id, itemId: item.id, status: 'completed', output: result.output });

      const run = state.subagentRuns.get(item.id);
      if (run) {
        run.status = 'completed';
        run.completedAt = new Date().toISOString();
        run.output = result.output;
      }

      recordStep(state, {
        step_type: 'subagent_message',
        model_name: result.model,
        message_content: result.output.substring(0, 500),
        tool_name: null,
        tool_input: { run_id: runId },
        tool_output: null,
        subagent_id: item.id,
      });

      emitWorkflowEvent(state, {
        type: 'task_completed',
        workflow_id: state.id,
        task_id: item.id,
        data: {
          output_preview: result.output.substring(0, 500),
          model: result.model,
          usage: result.usage,
        },
      });
    } catch (err) {
      const errorMessage = getErrorMessage(err, 'Subagent execution failed');
      updateWorkItem({ workflowId: state.id, itemId: item.id, status: 'failed', output: `[failed: ${errorMessage}]` });

      const run = state.subagentRuns.get(item.id);
      if (run) {
        run.status = 'failed';
        run.completedAt = new Date().toISOString();
        run.error = errorMessage;
      }

      recordStep(state, {
        step_type: 'system_event',
        model_name: null,
        message_content: 'task_failed',
        tool_name: null,
        tool_input: { run_id: runId },
        tool_output: { error: errorMessage },
        subagent_id: item.id,
      });

      emitWorkflowEvent(state, {
        type: 'task_failed',
        workflow_id: state.id,
        task_id: item.id,
        data: { error: errorMessage, run_id: runId },
      });
    }
  })();

  const run: SubagentRun = {
    runId,
    workItemId: item.id,
    status: 'running',
    startedAt,
    promise,
  };

  state.subagentRuns.set(item.id, run);
  return run;
};

export const getSubagentResult = (state: WorkflowState, todoId: string) => {
  const item = getWorkItem(state.id, todoId);
  if (!item) {
    return null;
  }

  const run = state.subagentRuns.get(item.id);
  return {
    status: run?.status ?? item.status,
    todo_id: item.id,
    display_todo_id: getWorkItemDisplayId(state.id, item.id),
    description: item.description,
    output: item.output ?? null,
    error: run?.error ?? null,
  };
};

export const areDependenciesSatisfied = (state: WorkflowState, item: WorkItem): boolean => {
  const todos = listWorkItems(state.id);
  return item.dependsOn.every((depId) => {
    const dep = todos.find((candidate) => candidate.id === depId);
    return dep?.status === 'completed';
  });
};
