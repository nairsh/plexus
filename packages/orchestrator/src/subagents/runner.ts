import { debitCredits } from '@orchestrator/billing';
import { dispatchToAgent, getAgentModel } from '../agents.js';
import type { AgentExecutionContext } from '../agents.js';
import {
  getWorkItem,
  getWorkItemDisplayId,
  isWorkItemDependencySatisfied,
  listWorkItems,
  updateWorkItem,
  type WorkItem,
} from '../workItems.js';
import {
  getErrorMessage,
  logger,
  SUBAGENT_DEFAULT_TIMEOUT_S,
  SUBAGENT_LONG_RUNNING_TIMEOUT_S,
  SUBAGENT_MAX_RETRIES,
} from '@orchestrator/shared';
import type { AgentType } from '@orchestrator/shared';
import { emitWorkflowEvent } from '../workflow/emitter.js';
import { incrementWorkflowCredits } from '../workflow/persistence.js';
import type { SubagentRun, WorkflowState } from '../workflow/state.js';
import { buildToolTraceHooks, recordStep } from '../orchestrator/tracing.js';
import { buildDisplayDescription } from '../orchestrator/displayLabel.js';

// ── Per-agent-type timeout configuration ─────────────────────────────────────

const AGENT_TIMEOUTS: Record<AgentType, number> = {
  research: SUBAGENT_LONG_RUNNING_TIMEOUT_S, // 30 min — deep research needs time
  analyze: SUBAGENT_DEFAULT_TIMEOUT_S, // 5 min
  write: SUBAGENT_DEFAULT_TIMEOUT_S, // 5 min
  code: SUBAGENT_LONG_RUNNING_TIMEOUT_S, // 30 min — iterative coding needs time
  file: SUBAGENT_DEFAULT_TIMEOUT_S, // 5 min
  deep_research: SUBAGENT_LONG_RUNNING_TIMEOUT_S,
};

// ── Exported helpers ──────────────────────────────────────────────────────────

export const waitForRuns = async (
  state: WorkflowState,
  todoIds?: string[],
  timeoutSeconds = 30
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
        if (result) completedResults.push(result);
      } else if (run.status === 'failed') {
        failed.push({ todo_id: id, error: run.error ?? 'Unknown error' });
      } else {
        running.push(id);
      }
    } catch (err) {
      logger.warn(
        { workflowId: state.id, todoId: id, error: getErrorMessage(err) },
        'Subagent wait timed out or failed'
      );
      running.push(id);
    }
  }

  return { completed, running, failed, completed_results: completedResults };
};

export const buildAgentTaskPrompt = (state: WorkflowState, item: WorkItem): string => {
  const lines = [`Task: ${item.description}`];

  if (item.dependsOn.length > 0) {
    const depOutputs = item.dependsOn
      .map((depId) => {
        const dep = getWorkItem(state.id, depId);
        if (!dep) return null;
        const displayId = getWorkItemDisplayId(state.id, depId);
        if (dep.output) {
          return `--- Output of ${displayId} (${dep.agentType}) ---\n${dep.output}\n--- End ${displayId} ---`;
        }
        return null;
      })
      .filter(Boolean);

    if (depOutputs.length > 0) {
      lines.push(`\n## Inputs from completed dependencies:\n${depOutputs.join('\n\n')}`);
    } else {
      lines.push(`\nDependencies: ${item.dependsOn.map((depId) => getWorkItemDisplayId(state.id, depId)).join(', ')}`);
    }
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
      logger.warn(
        { workflowId: state.id, error: getErrorMessage(err) },
        'Failed to debit credits for subagent (non-critical)'
      );
    }
  },
  trace: buildToolTraceHooks(state, taskId),
});

// ── Long-running subagent spawn ───────────────────────────────────────────────

export const spawnSubagentRun = async (
  state: WorkflowState,
  item: WorkItem,
  promptOverride?: string,
  displayDescription?: string
): Promise<SubagentRun> => {
  const existingRun = state.subagentRuns.get(item.id);
  if (existingRun && existingRun.status === 'running') {
    return existingRun;
  }

  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const agentTimeout = AGENT_TIMEOUTS[item.agentType] ?? SUBAGENT_DEFAULT_TIMEOUT_S;

  updateWorkItem({ workflowId: state.id, itemId: item.id, status: 'running' });

  recordStep(state, {
    step_type: 'subagent_spawn',
    model_name: null,
    message_content: item.description,
    tool_name: null,
    tool_input: { agent_type: item.agentType, depends_on: item.dependsOn, run_id: runId, timeout_s: agentTimeout },
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
      display_description: displayDescription ?? buildDisplayDescription(item.description, item.agentType),
      task_type: item.agentType,
      agent_type: item.agentType,
      origin: item.metadata.origin,
      output_artifact: item.metadata.output_artifact,
      run_id: runId,
      model: getAgentModel(item.agentType),
      timeout_s: agentTimeout,
    },
  });

  const prompt = promptOverride ?? buildAgentTaskPrompt(state, item);
  const agentCtx = buildAgentContext(state, item.id);

  const promise = runSubagentWithRetry(state, item, runId, prompt, agentCtx, agentTimeout);

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

// ── Internal: run with retry and progress heartbeat ───────────────────────────

async function runSubagentWithRetry(
  state: WorkflowState,
  item: WorkItem,
  runId: string,
  prompt: string,
  agentCtx: AgentExecutionContext,
  timeoutSeconds: number
): Promise<void> {
  let lastError: string | null = null;

  for (let attempt = 0; attempt <= SUBAGENT_MAX_RETRIES; attempt++) {
    if (state.abortController.signal.aborted) {
      throw new Error('Workflow aborted');
    }

    if (attempt > 0) {
      logger.info({ workflowId: state.id, itemId: item.id, attempt }, 'Retrying subagent after failure');
      // Enrich prompt with the error from the previous attempt for self-correction
      prompt = `${prompt}\n\n## Previous attempt failed:\n${lastError ?? 'Unknown error'}\n\nPlease fix the issue and try again.`;
    }

    // Start a progress heartbeat that emits periodic events for long-running agents
    const stopHeartbeat = startProgressHeartbeat(state, item.id, runId, timeoutSeconds);

    try {
      const result = await withTimeout(
        dispatchToAgent(
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
          agentCtx
        ),
        timeoutSeconds * 1000,
        `Subagent ${item.id} timed out after ${timeoutSeconds}s`
      );

      stopHeartbeat();

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
        tool_input: { run_id: runId, attempt },
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
          attempt,
        },
      });

      return; // Success — exit retry loop
    } catch (err) {
      stopHeartbeat();
      lastError = getErrorMessage(err, 'Subagent execution failed');

      logger.warn({ workflowId: state.id, itemId: item.id, attempt, error: lastError }, 'Subagent attempt failed');

      if (attempt >= SUBAGENT_MAX_RETRIES) {
        // All retries exhausted
        updateWorkItem({
          workflowId: state.id,
          itemId: item.id,
          status: 'failed',
          output: `[failed after ${attempt + 1} attempts: ${lastError}]`,
        });

        const run = state.subagentRuns.get(item.id);
        if (run) {
          run.status = 'failed';
          run.completedAt = new Date().toISOString();
          run.error = lastError;
        }

        recordStep(state, {
          step_type: 'system_event',
          model_name: null,
          message_content: 'task_failed',
          tool_name: null,
          tool_input: { run_id: runId, attempts: attempt + 1 },
          tool_output: { error: lastError },
          subagent_id: item.id,
        });

        emitWorkflowEvent(state, {
          type: 'task_failed',
          workflow_id: state.id,
          task_id: item.id,
          data: { error: lastError, run_id: runId, attempts: attempt + 1 },
        });
      }
      // Loop continues for retry
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    );
  });
}

function startProgressHeartbeat(
  state: WorkflowState,
  taskId: string,
  runId: string,
  timeoutSeconds: number
): () => void {
  // Emit a progress ping every 30s so the UI knows the agent is alive
  const intervalMs = Math.min(30_000, Math.floor((timeoutSeconds * 1000) / 4));
  const start = Date.now();

  const timer = setInterval(() => {
    if (state.abortController.signal.aborted) {
      clearInterval(timer);
      return;
    }

    const elapsedS = Math.floor((Date.now() - start) / 1000);
    emitWorkflowEvent(state, {
      type: 'task_started', // Reuse task_started for heartbeat, data distinguishes it
      workflow_id: state.id,
      task_id: taskId,
      data: {
        type: 'heartbeat',
        run_id: runId,
        elapsed_s: elapsedS,
        timeout_s: timeoutSeconds,
      },
    });
  }, intervalMs);

  return () => clearInterval(timer);
}

export const getSubagentResult = (state: WorkflowState, todoId: string) => {
  const item = getWorkItem(state.id, todoId);
  if (!item) return null;

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
  const byId = new Map(todos.map((todo) => [todo.id, todo] as const));
  return item.dependsOn.every((depId) => {
    const dep = byId.get(depId);
    return dep ? isWorkItemDependencySatisfied(dep.status) : false;
  });
};
