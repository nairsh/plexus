import { getDb, getErrorMessage, logger } from '@orchestrator/shared';
import type { OrchestratorTask, WorkflowConfig } from '@orchestrator/shared';
import { resolveOrchestratorModel } from '@orchestrator/model-router';
import type { WorkItem } from '../workItems.js';
import {
  createWorkflowState,
  type TaskSummary,
  type WorkflowState,
  type WorkflowStatus,
  type WorkflowSummary,
  workflows,
} from './state.js';

const readWorkflowOutputFromTrace = (workflowId: string): string | null => {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT tool_output
       FROM workflow_steps
       WHERE workflow_id = ? AND message_content = 'workflow_completed'
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .get(workflowId) as { tool_output: string | null } | undefined;

  if (!row?.tool_output) return null;

  try {
    const parsed = JSON.parse(row.tool_output) as { output?: unknown };
    return typeof parsed.output === 'string' ? parsed.output : null;
  } catch {
    return null;
  }
};

export const hydrateWorkflowState = (workflowId: string): WorkflowState | null => {
  const existing = workflows.get(workflowId);
  if (existing) return existing;

  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, user_id, objective, orchestrator_model, status, config, credits_consumed
       FROM workflows
       WHERE id = ?`
    )
    .get(workflowId) as
    | {
        id: string;
        user_id: string;
        objective: string;
        orchestrator_model: string | null;
        status: WorkflowStatus;
        config: string | null;
        credits_consumed: number | null;
      }
    | undefined;

  if (!row) return null;

  let config: WorkflowConfig = { objective: row.objective };
  if (row.config) {
    try {
      const parsed = JSON.parse(row.config) as WorkflowConfig;
      if (parsed && typeof parsed === 'object' && typeof parsed.objective === 'string') {
        config = parsed;
      }
    } catch (error) {
      logger.warn({ workflowId, error: getErrorMessage(error) }, 'Failed to parse workflow config from persistence');
    }
  }

  const output = readWorkflowOutputFromTrace(workflowId);
  const baseHistory = [{ role: 'user' as const, content: row.objective, timestamp: new Date().toISOString() }];
  const state = createWorkflowState({
    id: row.id,
    userId: row.user_id,
    config,
    orchestratorModel: row.orchestrator_model ?? resolveOrchestratorModel(undefined, row.user_id),
    status: row.status,
    creditsConsumed: row.credits_consumed ?? 0,
    lastOutput: output ?? undefined,
    messages: output
      ? [
          { role: 'user', content: row.objective },
          { role: 'assistant', content: output },
        ]
      : [{ role: 'user', content: row.objective }],
    conversationHistory: output
      ? [...baseHistory, { role: 'assistant' as const, content: output, timestamp: new Date().toISOString() }]
      : baseHistory,
  });

  workflows.set(workflowId, state);
  return state;
};

export const incrementWorkflowCredits = (state: WorkflowState, amount: number): void => {
  if (!amount || amount <= 0) return;
  state.creditsConsumed += amount;

  const db = getDb();
  db.prepare(
    `UPDATE workflows
     SET credits_consumed = COALESCE(credits_consumed, 0) + ?,
         updated_at = datetime('now')
     WHERE id = ?`
  ).run(amount, state.id);
};

export const persistWorkflowCompletion = (state: WorkflowState): void => {
  const db = getDb();
  db.prepare(
    `UPDATE workflows SET status = 'completed', ended_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
  ).run(state.id);
};

export const persistWorkflowFailure = (state: WorkflowState, message: string): void => {
  const db = getDb();
  db.prepare(`UPDATE workflows SET status = 'failed', ended_at = datetime('now'), error = ? WHERE id = ?`).run(
    message,
    state.id
  );
};

export const persistWorkflowCancellation = (workflowId: string): void => {
  const db = getDb();
  db.prepare("UPDATE workflows SET status = 'cancelled', ended_at = datetime('now') WHERE id = ?").run(workflowId);
  db.prepare(
    "UPDATE tasks SET status = 'cancelled', completed_at = datetime('now') WHERE workflow_id = ? AND status IN ('pending', 'running')"
  ).run(workflowId);
};

export const persistWorkflowStatus = (workflowId: string, status: WorkflowStatus): void => {
  const db = getDb();
  db.prepare(`UPDATE workflows SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, workflowId);
};

export const insertWorkflow = (
  workflowId: string,
  userId: string,
  config: WorkflowConfig,
  orchestratorModel: string
): void => {
  const db = getDb();
  db.prepare(
    `INSERT INTO workflows (id, user_id, objective, user_prompt, orchestrator_model, status, config, started_at)
     VALUES (?, ?, ?, ?, ?, 'executing', ?, datetime('now'))`
  ).run(workflowId, userId, config.objective, config.objective, orchestratorModel, JSON.stringify(config));
};

export const updateWorkflowObjectiveForContinuation = (workflowId: string, followUpQuery: string): void => {
  const db = getDb();
  db.prepare(`UPDATE workflows SET status = 'executing', objective = ?, updated_at = datetime('now') WHERE id = ?`).run(
    followUpQuery,
    workflowId
  );
};

export const toPublicTask = (item: WorkItem): OrchestratorTask => ({
  task_id: item.id,
  description: item.description,
  agent_type: item.agentType,
  depends_on: item.dependsOn,
  status: item.status,
  origin: item.metadata.origin,
  semantic_key: item.metadata.semantic_key,
  output_artifact: item.metadata.output_artifact,
  reason_generated: item.metadata.reason_generated,
  supersedes_task_id: item.metadata.supersedes_task_id,
});

export const getWorkflowDetails = (workflowId: string): { workflow: WorkflowSummary; tasks: TaskSummary[] } | null => {
  const db = getDb();
  const workflow = db
    .prepare(
      `SELECT id, objective, user_prompt, orchestrator_model, status,
              error, credits_consumed, started_at, ended_at, created_at, updated_at, completed_at
       FROM workflows WHERE id = ?`
    )
    .get(workflowId) as WorkflowSummary | undefined;

  if (!workflow) return null;

  const inMemoryState = workflows.get(workflowId);
  if (inMemoryState?.lastOutput) {
    workflow.output = inMemoryState.lastOutput;
  }

  const taskRows = db
    .prepare(
      `SELECT
          id AS task_id,
          description,
          task_type AS agent_type,
          parent_task_ids,
          status,
          output,
          created_at,
          completed_at
       FROM tasks
       WHERE workflow_id = ?
       ORDER BY created_at`
    )
    .all(workflowId) as Array<{
    task_id: string;
    description: string | null;
    agent_type: string;
    parent_task_ids: string | null;
    status: string;
    output: string | null;
    created_at: string;
    completed_at: string | null;
  }>;

  const tasks: TaskSummary[] = taskRows.map((row) => {
    let dependsOn: string[] = [];
    try {
      dependsOn = JSON.parse(row.parent_task_ids ?? '[]') as string[];
    } catch (error) {
      logger.warn(
        { workflowId, taskId: row.task_id, error: getErrorMessage(error) },
        'Failed to parse task dependency list'
      );
      dependsOn = [];
    }

    return {
      task_id: row.task_id,
      description: row.description ?? '',
      agent_type: row.agent_type,
      depends_on: dependsOn,
      status: row.status,
      output: row.output ?? undefined,
      created_at: row.created_at,
      completed_at: row.completed_at,
    };
  });

  return { workflow, tasks };
};

export const listWorkflows = (userId: string): WorkflowSummary[] => {
  const db = getDb();
  const workflowsFromDb = db
    .prepare(
      `SELECT id, objective, user_prompt, orchestrator_model, status,
              error, credits_consumed, started_at, ended_at, created_at, updated_at, completed_at
       FROM workflows WHERE user_id = ? ORDER BY created_at DESC`
    )
    .all(userId) as WorkflowSummary[];

  return workflowsFromDb.map((workflow) => {
    const inMemory = workflows.get(workflow.id);
    return inMemory?.lastOutput ? { ...workflow, output: inMemory.lastOutput } : workflow;
  });
};

export const getWorkflowSummaryById = (
  workflowId: string
): { workflowId: string; status: WorkflowStatus; output?: string | null } | null => {
  const state = hydrateWorkflowState(workflowId);
  if (state) {
    return {
      workflowId,
      status: state.status,
      output: state.lastOutput ?? null,
    };
  }

  const db = getDb();
  const row = db.prepare(`SELECT id, status FROM workflows WHERE id = ?`).get(workflowId) as
    | { id: string; status: WorkflowStatus }
    | undefined;

  if (!row) return null;

  return {
    workflowId: row.id,
    status: row.status,
    output: null,
  };
};
