import { getDb, getErrorMessage, InvalidRequestError, logger, parseRow, TaskRowSchema } from '@orchestrator/shared';
import type { AgentType, TaskMetadata, TaskRow } from '@orchestrator/shared';
import { validateWorkItemGraph, formatGraphErrors } from './validateWorkItemGraph.js';

export type WorkItemStatus = 'pending' | 'running' | 'completed' | 'failed' | 'blocked' | 'cancelled' | 'skipped';

export interface WorkItem {
  id: string;
  workflowId: string;
  description: string;
  agentType: AgentType;
  dependsOn: string[];
  status: WorkItemStatus;
  output?: string;
  metadata: TaskMetadata;
  assignedModel?: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
}

const DEFAULT_METADATA: TaskMetadata = { origin: 'planned' };

export const isWorkItemDependencySatisfied = (status: WorkItemStatus): boolean => {
  return status === 'completed' || status === 'skipped';
};

export const isWorkItemSettled = (status: WorkItemStatus): boolean => {
  return status === 'completed' || status === 'failed' || status === 'skipped' || status === 'cancelled';
};

function parseMetadata(rawValue: string | null): TaskMetadata {
  if (!rawValue) {
    return DEFAULT_METADATA;
  }

  try {
    const parsed = JSON.parse(rawValue) as Partial<TaskMetadata>;
    return {
      origin: parsed.origin === 'runtime_generated' ? 'runtime_generated' : 'planned',
      semantic_key: typeof parsed.semantic_key === 'string' ? parsed.semantic_key : undefined,
      output_artifact: typeof parsed.output_artifact === 'string' ? parsed.output_artifact : undefined,
      reason_generated: typeof parsed.reason_generated === 'string' ? parsed.reason_generated : undefined,
      supersedes_task_id: typeof parsed.supersedes_task_id === 'string' ? parsed.supersedes_task_id : undefined,
    };
  } catch (error) {
    logger.warn({ error: getErrorMessage(error), rawValue }, 'Failed to parse task metadata');
    return DEFAULT_METADATA;
  }
}

function toWorkItem(row: TaskRow): WorkItem {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    description: row.description ?? '',
    agentType: row.task_type as AgentType,
    dependsOn: JSON.parse(row.parent_task_ids || '[]') as string[],
    status: row.status as WorkItemStatus,
    output: row.output ?? undefined,
    metadata: parseMetadata(row.tools),
    assignedModel: row.model,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export function resolveWorkItemId(workflowId: string, itemId: string): string {
  if (itemId.startsWith(`${workflowId}_`)) {
    return itemId;
  }
  return `${workflowId}_${itemId}`;
}

export function getWorkItemDisplayId(workflowId: string, itemId: string): string {
  const prefix = `${workflowId}_`;
  return itemId.startsWith(prefix) ? itemId.slice(prefix.length) : itemId;
}

export function listWorkItems(workflowId: string): WorkItem[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, workflow_id, description, task_type, parent_task_ids, status, output, model, tools,
              created_at, updated_at, started_at, completed_at
       FROM tasks
       WHERE workflow_id = ?
       ORDER BY created_at ASC`
    )
    .all(workflowId);

  return rows.map((r) => toWorkItem(parseRow(TaskRowSchema, r)));
}

export function getWorkItem(workflowId: string, itemId: string): WorkItem | null {
  const db = getDb();
  const fullId = resolveWorkItemId(workflowId, itemId);
  const row = db
    .prepare(
      `SELECT id, workflow_id, description, task_type, parent_task_ids, status, output, model, tools,
              created_at, updated_at, started_at, completed_at
       FROM tasks
       WHERE workflow_id = ? AND id = ?`
    )
    .get(workflowId, fullId);

  return row ? toWorkItem(parseRow(TaskRowSchema, row)) : null;
}

export function createWorkItem(input: {
  workflowId: string;
  itemId: string;
  description: string;
  agentType: AgentType;
  dependsOn?: string[];
  metadata?: TaskMetadata;
  assignedModel?: string | null;
}): WorkItem {
  const db = getDb();
  const id = resolveWorkItemId(input.workflowId, input.itemId);
  const dependsOn = (input.dependsOn ?? []).map((depId) => resolveWorkItemId(input.workflowId, depId));

  // Hard invariant: a task must never depend on itself.
  if (dependsOn.includes(id)) {
    throw new InvalidRequestError(`Task '${input.itemId}' cannot depend on itself`, 'depends_on');
  }

  const metadata = {
    origin: input.metadata?.origin === 'runtime_generated' ? 'runtime_generated' : 'planned',
    semantic_key: input.metadata?.semantic_key ?? null,
    output_artifact: input.metadata?.output_artifact ?? null,
    reason_generated: input.metadata?.reason_generated ?? null,
    supersedes_task_id: input.metadata?.supersedes_task_id ?? null,
  };

  db.prepare(
    `INSERT INTO tasks (
      id, workflow_id, parent_task_ids, task_type, description, model, tools, input_context,
      status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'), datetime('now'))`
  ).run(
    id,
    input.workflowId,
    JSON.stringify(dependsOn),
    input.agentType,
    input.description,
    input.assignedModel ?? null,
    JSON.stringify(metadata),
    input.description
  );

  const created = getWorkItem(input.workflowId, id);
  if (!created) {
    throw new Error(`Failed to create work item: ${id}`);
  }

  logger.info({ workflowId: input.workflowId, itemId: id, agentType: input.agentType }, 'Work item created');
  return created;
}

export function updateWorkItem(input: {
  workflowId: string;
  itemId: string;
  description?: string;
  dependsOn?: string[];
  status?: WorkItemStatus;
  output?: string;
  metadata?: TaskMetadata;
  assignedModel?: string | null;
}): WorkItem {
  const db = getDb();
  const id = resolveWorkItemId(input.workflowId, input.itemId);
  const sets: string[] = ["updated_at = datetime('now')"];
  const params: unknown[] = [];

  if (input.description !== undefined) {
    sets.push('description = ?');
    params.push(input.description);
  }

  if (input.dependsOn !== undefined) {
    sets.push('parent_task_ids = ?');
    params.push(JSON.stringify(input.dependsOn.map((depId) => resolveWorkItemId(input.workflowId, depId))));
  }

  if (input.status !== undefined) {
    sets.push('status = ?');
    params.push(input.status);

    if (input.status === 'running') {
      sets.push("started_at = datetime('now')");
    }

    if (
      input.status === 'completed' ||
      input.status === 'failed' ||
      input.status === 'skipped' ||
      input.status === 'cancelled'
    ) {
      sets.push("completed_at = datetime('now')");
    }
  }

  if (input.output !== undefined) {
    sets.push('output = ?');
    params.push(input.output.substring(0, 10000));
  }

  if (input.assignedModel !== undefined) {
    sets.push('model = ?');
    params.push(input.assignedModel);
  }

  if (input.metadata !== undefined) {
    const metadata = {
      origin: input.metadata.origin === 'runtime_generated' ? 'runtime_generated' : 'planned',
      semantic_key: input.metadata.semantic_key ?? null,
      output_artifact: input.metadata.output_artifact ?? null,
      reason_generated: input.metadata.reason_generated ?? null,
      supersedes_task_id: input.metadata.supersedes_task_id ?? null,
    };
    sets.push('tools = ?');
    params.push(JSON.stringify(metadata));
  }

  params.push(id);
  params.push(input.workflowId);

  db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ? AND workflow_id = ?`).run(...params);

  const updated = getWorkItem(input.workflowId, id);
  if (!updated) {
    throw new Error(`Failed to update work item: ${id}`);
  }

  return updated;
}

export function getReadyWorkItems(workItems: WorkItem[]): WorkItem[] {
  // Validate graph structure — throw on hard errors (cycles, self-deps) that
  // would cause the workflow to hang silently.
  const validation = validateWorkItemGraph(workItems);
  if (!validation.valid) {
    const blocking = validation.errors.filter(
      (e) => e.type === 'dependency_cycle' || e.type === 'self_dependency' || e.type === 'duplicate_id'
    );
    if (blocking.length > 0) {
      throw new InvalidRequestError(`Invalid work item graph: ${formatGraphErrors(blocking)}`, 'depends_on');
    }
    // Dangling deps are non-blocking here — more items may be added later.
  }

  const byId = new Map(workItems.map((item) => [item.id, item] as const));
  return workItems.filter((item) => {
    if (item.status !== 'pending') return false;
    return item.dependsOn.every((depId) => {
      const dep = byId.get(depId);
      return dep ? isWorkItemDependencySatisfied(dep.status) : false;
    });
  });
}

export function areWorkItemsSettled(workItems: WorkItem[]): boolean {
  return workItems.every((item) => isWorkItemSettled(item.status));
}

export function formatWorkItemsForPrompt(workItems: WorkItem[], maxOutputLength = 1500): string {
  const lines: string[] = [];
  const completed = workItems.filter((item) => item.status === 'completed').length;
  const running = workItems.filter((item) => item.status === 'running').length;
  const pending = workItems.filter((item) => item.status === 'pending').length;

  lines.push('## Work Items');
  lines.push(`Total: ${workItems.length} | Completed: ${completed} | Running: ${running} | Pending: ${pending}`);
  lines.push('');

  for (const item of workItems) {
    const displayId = getWorkItemDisplayId(item.workflowId, item.id);
    const displayDeps = item.dependsOn.map((depId) => getWorkItemDisplayId(item.workflowId, depId));
    const deps = displayDeps.length > 0 ? ` [depends_on: ${displayDeps.join(', ')}]` : '';
    lines.push(`- ${displayId} (${item.agentType}) [${item.status}]${deps}: ${item.description}`);
    if (item.metadata.output_artifact) {
      lines.push(`  artifact: ${item.metadata.output_artifact}`);
    }
    if (item.output && (item.status === 'completed' || item.status === 'failed')) {
      const preview =
        item.output.length > maxOutputLength
          ? `${item.output.substring(0, maxOutputLength)}\n[...truncated...]`
          : item.output;
      lines.push(`  output: ${preview.replace(/\n/g, ' ')}`);
    }
  }

  return lines.join('\n');
}
