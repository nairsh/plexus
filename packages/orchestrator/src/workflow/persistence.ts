import { getDb, getErrorMessage, logger } from '@orchestrator/shared';
import type { ConversationMessage, OrchestratorTask, WorkflowConfig } from '@orchestrator/shared';
import { resolveOrchestratorModel } from '@orchestrator/model-router';
import type { WorkItem } from '../workItems.js';
import { normalizeWorkingDirectory } from '../folderScope.js';
import {
  createWorkflowState,
  type TaskSummary,
  type WorkflowState,
  type WorkflowStatus,
  type WorkflowSummary,
  workflows,
} from './state.js';

// ── Workflow State Snapshot Types ──────────────────────────────────────────────

/** Serialisable metadata for a pending approval (excludes the Promise resolver). */
export interface ApprovalMetadata {
  approvalId: string;
  commandKey?: string;
  command?: string;
  toolName?: string;
  subagentId?: string;
  requestedAt: string;
}

/** Serialisable summary of a subagent run (excludes the live Promise). */
export interface SubagentRunSummary {
  runId: string;
  workItemId: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  completedAt?: string;
  output?: string;
  error?: string;
}

export interface WorkflowStateSnapshot {
  workflowId: string;
  version: number;
  messages: ConversationMessage[];
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string; timestamp: string }>;
  config: WorkflowConfig;
  pendingApprovalMetadata: ApprovalMetadata[];
  subagentSummaries: SubagentRunSummary[];
  creditsConsumed: number;
  status: WorkflowStatus;
  createdAt: string;
}

// ── Snapshot Persistence ──────────────────────────────────────────────────────

/**
 * Persist a durable snapshot of the workflow's conversational state.
 *
 * Each call auto-increments `version` per workflow so the snapshot history is
 * fully auditable. Only the latest version is used during hydration.
 */
export const persistWorkflowSnapshot = (state: WorkflowState): void => {
  const db = getDb();

  // Derive next version number
  const lastRow = db
    .prepare('SELECT MAX(version) AS max_v FROM workflow_state_snapshots WHERE workflow_id = ?')
    .get(state.id) as { max_v: number | null } | undefined;
  const nextVersion = (lastRow?.max_v ?? 0) + 1;

  // Serialise approval metadata (strip the Promise-based `resolve` callback)
  const approvalMetadata: ApprovalMetadata[] = Array.from(
    state.approvalState.pending.entries(),
  ).map(([approvalId, entry]) => ({
    approvalId,
    commandKey: entry.commandKey,
    command: entry.command,
    toolName: entry.toolName,
    subagentId: entry.subagentId,
    requestedAt: entry.requestedAt,
  }));

  // Serialise subagent runs (strip the live Promise)
  const subagentSummaries: SubagentRunSummary[] = Array.from(state.subagentRuns.values()).map(
    (run) => ({
      runId: run.runId,
      workItemId: run.workItemId,
      status: run.status,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      output: run.output,
      error: run.error,
    }),
  );

  db.prepare(
    `INSERT INTO workflow_state_snapshots
       (workflow_id, version, messages, conversation_history, config,
        pending_approval_metadata, subagent_summaries, credits_consumed, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    state.id,
    nextVersion,
    JSON.stringify(state.messages),
    JSON.stringify(state.conversationHistory),
    JSON.stringify(state.config),
    JSON.stringify(approvalMetadata),
    JSON.stringify(subagentSummaries),
    state.creditsConsumed,
    state.status,
  );
};

/**
 * Load the latest durable snapshot for a workflow, or `null` if none exists.
 */
export const loadLatestSnapshot = (workflowId: string): WorkflowStateSnapshot | null => {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT workflow_id, version, messages, conversation_history, config,
              pending_approval_metadata, subagent_summaries, credits_consumed, status, created_at
       FROM workflow_state_snapshots
       WHERE workflow_id = ?
       ORDER BY version DESC
       LIMIT 1`,
    )
    .get(workflowId) as
    | {
        workflow_id: string;
        version: number;
        messages: string;
        conversation_history: string;
        config: string;
        pending_approval_metadata: string | null;
        subagent_summaries: string | null;
        credits_consumed: number;
        status: string;
        created_at: string;
      }
    | undefined;

  if (!row) return null;

  return {
    workflowId: row.workflow_id,
    version: row.version,
    messages: JSON.parse(row.messages) as ConversationMessage[],
    conversationHistory: JSON.parse(row.conversation_history) as Array<{
      role: 'user' | 'assistant';
      content: string;
      timestamp: string;
    }>,
    config: JSON.parse(row.config) as WorkflowConfig,
    pendingApprovalMetadata: row.pending_approval_metadata
      ? (JSON.parse(row.pending_approval_metadata) as ApprovalMetadata[])
      : [],
    subagentSummaries: row.subagent_summaries
      ? (JSON.parse(row.subagent_summaries) as SubagentRunSummary[])
      : [],
    creditsConsumed: row.credits_consumed,
    status: row.status as WorkflowStatus,
    createdAt: row.created_at,
  };
};

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

  // Try loading a durable snapshot first — this preserves the full conversational
  // state across server restarts and pause/resume cycles.
  const snapshot = loadLatestSnapshot(workflowId);

  let config: WorkflowConfig = { objective: row.objective };
  if (snapshot) {
    // Snapshot config is authoritative — it reflects continuation updates.
    config = snapshot.config;
  } else if (row.config) {
    try {
      const parsed = JSON.parse(row.config) as WorkflowConfig;
      if (parsed && typeof parsed === 'object' && typeof parsed.objective === 'string') {
        config = parsed;
      }
    } catch (error) {
      logger.warn({ workflowId, error: getErrorMessage(error) }, 'Failed to parse workflow config from persistence');
    }
  }

  let messages: ConversationMessage[];
  let conversationHistory: Array<{ role: 'user' | 'assistant'; content: string; timestamp: string }>;
  let creditsConsumed: number;
  let lastOutput: string | undefined;

  if (snapshot) {
    messages = snapshot.messages;
    conversationHistory = snapshot.conversationHistory;
    creditsConsumed = snapshot.creditsConsumed;
    // Derive lastOutput from the last assistant message in the snapshot
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
    lastOutput = typeof lastAssistant?.content === 'string' ? lastAssistant.content : undefined;
  } else {
    // Fallback: reconstruct minimal state from trace (legacy path for pre-snapshot workflows)
    const output = readWorkflowOutputFromTrace(workflowId);
    const baseHistory = [{ role: 'user' as const, content: row.objective, timestamp: new Date().toISOString() }];
    creditsConsumed = row.credits_consumed ?? 0;
    lastOutput = output ?? undefined;
    messages = output
      ? [
          { role: 'user', content: row.objective },
          { role: 'assistant', content: output },
        ]
      : [{ role: 'user', content: row.objective }];
    conversationHistory = output
      ? [...baseHistory, { role: 'assistant' as const, content: output, timestamp: new Date().toISOString() }]
      : baseHistory;
  }

  const state = createWorkflowState({
    id: row.id,
    userId: row.user_id,
    config,
    orchestratorModel: row.orchestrator_model ?? resolveOrchestratorModel(undefined, row.user_id),
    status: row.status,
    creditsConsumed,
    lastOutput,
    messages,
    conversationHistory,
  });

  workflows.set(workflowId, state);

  // Schedule TTL cleanup for terminal states so the in-memory map doesn't grow unboundedly
  // when old completed/failed workflows are re-hydrated by read-path queries.
  if (state.status === 'completed' || state.status === 'failed' || state.status === 'cancelled') {
    const TERMINAL_STATE_TTL_MS = 5 * 60 * 1000;
    setTimeout(() => {
      if (workflows.get(workflowId) === state) {
        workflows.delete(workflowId);
      }
    }, TERMINAL_STATE_TTL_MS);
  }

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

export const persistWorkflowCompletion = (state: WorkflowState, output?: string): void => {
  const db = getDb();
  db.prepare(
    `UPDATE workflows SET status = 'completed', output = ?, ended_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
  ).run(output ?? state.lastOutput ?? null, state.id);
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
  db.transaction(() => {
    db.prepare("UPDATE workflows SET status = 'cancelled', ended_at = datetime('now') WHERE id = ?").run(workflowId);
    db.prepare(
      "UPDATE tasks SET status = 'cancelled', completed_at = datetime('now') WHERE workflow_id = ? AND status IN ('pending', 'running')"
    ).run(workflowId);
  })();
};

export const persistWorkflowStatus = (workflowId: string, status: WorkflowStatus, pauseReason?: string): void => {
  const db = getDb();
  if (pauseReason !== undefined) {
    db.prepare(`UPDATE workflows SET status = ?, pause_reason = ?, updated_at = datetime('now') WHERE id = ?`).run(status, pauseReason, workflowId);
  } else {
    db.prepare(`UPDATE workflows SET status = ?, pause_reason = NULL, updated_at = datetime('now') WHERE id = ?`).run(status, workflowId);
  }
};

export const insertWorkflow = (
  workflowId: string,
  userId: string,
  config: WorkflowConfig,
  orchestratorModel: string
): void => {
  const db = getDb();
  const normalizedConfig: WorkflowConfig = {
    ...config,
    ...(config.working_directory ? { working_directory: normalizeWorkingDirectory(config.working_directory) } : {}),
  };
  db.prepare(
    `INSERT INTO workflows (id, user_id, objective, user_prompt, orchestrator_model, status, config, team_id, started_at)
     VALUES (?, ?, ?, ?, ?, 'executing', ?, ?, datetime('now'))`
  ).run(
    workflowId,
    userId,
    normalizedConfig.objective,
    normalizedConfig.objective,
    orchestratorModel,
    JSON.stringify(normalizedConfig),
    normalizedConfig.team_id ?? null
  );
};

export const updateWorkflowObjectiveForContinuation = (workflowId: string, followUpQuery: string): void => {
  const db = getDb();
  // Update objective and also patch the config JSON so the persisted config
  // stays consistent with the in-memory state after continuation.
  const existingRow = db
    .prepare('SELECT config FROM workflows WHERE id = ?')
    .get(workflowId) as { config: string | null } | undefined;
  let updatedConfig: string | null = null;
  if (existingRow?.config) {
    try {
      const parsed = JSON.parse(existingRow.config) as WorkflowConfig;
      parsed.objective = followUpQuery;
      updatedConfig = JSON.stringify(parsed);
    } catch {
      updatedConfig = JSON.stringify({ objective: followUpQuery });
    }
  } else {
    updatedConfig = JSON.stringify({ objective: followUpQuery });
  }
  db.prepare(
    `UPDATE workflows SET status = 'executing', objective = ?, config = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(followUpQuery, updatedConfig, workflowId);
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
              error, credits_consumed, started_at, ended_at, created_at, updated_at, completed_at,
              pause_reason, output
       FROM workflows WHERE id = ?`
    )
    .get(workflowId) as (WorkflowSummary & { output?: string | null }) | undefined;

  if (!workflow) return null;

  const inMemoryState = workflows.get(workflowId);
  if (inMemoryState?.lastOutput) {
    workflow.output = inMemoryState.lastOutput;
  }

  // Populate pending_clarification for paused workflows that have a clarification question
  if (workflow.status === 'paused' && workflow.pause_reason) {
    workflow.pending_clarification = workflow.pause_reason;
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

export const listWorkflows = (
  userId: string,
  options?: { status?: string; limit?: number; offset?: number },
): WorkflowSummary[] => {
  const db = getDb();
  const conditions = ['user_id = ?'];
  const params: unknown[] = [userId];

  if (options?.status) {
    conditions.push('status = ?');
    params.push(options.status);
  }

  const limitClause = options?.limit ? ` LIMIT ?` : '';
  const offsetClause = options?.offset ? ` OFFSET ?` : '';
  if (options?.limit) params.push(options.limit);
  if (options?.offset) params.push(options.offset);

  const workflowsFromDb = db
    .prepare(
      `SELECT id, objective, user_prompt, orchestrator_model, status,
              error, credits_consumed, started_at, ended_at, created_at, updated_at, completed_at, output
       FROM workflows WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC${limitClause}${offsetClause}`
    )
    .all(...params) as WorkflowSummary[];

  return workflowsFromDb.map((workflow) => {
    const inMemory = workflows.get(workflow.id);
    return inMemory?.lastOutput ? { ...workflow, output: inMemory.lastOutput } : workflow;
  });
};

export const countWorkflows = (userId: string, status?: string): number => {
  const db = getDb();
  if (status) {
    return (db.prepare('SELECT COUNT(*) as count FROM workflows WHERE user_id = ? AND status = ?').get(userId, status) as { count: number }).count;
  }
  return (db.prepare('SELECT COUNT(*) as count FROM workflows WHERE user_id = ?').get(userId) as { count: number }).count;
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
