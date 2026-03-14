import { getDb, logger } from '@orchestrator/shared';
import type { AgentType, TaskMetadata, TaskOrigin } from '@orchestrator/shared';

export interface TodoTask {
  task_id: string;
  description: string;
  agent_type: AgentType;
  depends_on: string[];
  status: 'pending' | 'running' | 'completed' | 'failed' | 'blocked' | 'cancelled' | 'skipped';
  output?: string;
  origin: TaskOrigin;
  semantic_key?: string | null;
  output_artifact?: string | null;
  reason_generated?: string | null;
  supersedes_task_id?: string | null;
  created_at: string;
  updated_at: string;
}

export interface TodoList {
  workflow_id: string;
  tasks: TodoTask[];
  completed_count: number;
  pending_count: number;
  failed_count: number;
}

/**
 * Get the current todo list for a workflow.
 * Reads from the database to ensure we have the latest state.
 */
export async function getTodoList(workflowId: string): Promise<TodoList> {
  const db = getDb();
  
  const rows = db.prepare(
    `SELECT id as task_id, description, task_type as agent_type, parent_task_ids as depends_on,
            status, output, created_at, updated_at, model, tools
     FROM tasks 
     WHERE workflow_id = ? 
     ORDER BY created_at`
  ).all(workflowId) as Array<{
    task_id: string;
    description: string;
    agent_type: string;
    depends_on: string;
    status: string;
    output: string | null;
    created_at: string;
    updated_at: string;
    model: string | null;
    tools: string | null;
  }>;

  const tasks: TodoTask[] = rows.map(row => ({
    ...parseTaskMetadata(row.model, row.tools),
    task_id: row.task_id,
    description: row.description,
    agent_type: row.agent_type as AgentType,
    depends_on: JSON.parse(row.depends_on || '[]'),
    status: row.status as TodoTask['status'],
    output: row.output || undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));

  return {
    workflow_id: workflowId,
    tasks,
    completed_count: tasks.filter(t => t.status === 'completed').length,
    pending_count: tasks.filter(t => t.status === 'pending').length,
    failed_count: tasks.filter(t => t.status === 'failed').length,
  };
}

/**
 * Add a new task to the todo list.
 * Persists to database and returns the created task.
 */
export async function addTodoTask(
  workflowId: string,
  taskId: string,
  description: string,
  agentType: AgentType,
  dependsOn: string[] = [],
  metadata: TaskMetadata = { origin: 'planned' }
): Promise<TodoTask> {
  const db = getDb();
  
  // Ensure task_id is unique by prefixing with workflow_id if not already
  const fullTaskId = taskId.startsWith(`${workflowId}_`) ? taskId : `${workflowId}_${taskId}`;
  
  // Resolve dependency IDs to full IDs
  const resolvedDeps = dependsOn.map(depId => 
    depId.startsWith(`${workflowId}_`) ? depId : `${workflowId}_${depId}`
  );

  db.prepare(
    `INSERT INTO tasks (id, workflow_id, parent_task_ids, task_type, description, model, tools, input_context, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'), datetime('now'))`
  ).run(
    fullTaskId,
    workflowId,
    JSON.stringify(resolvedDeps),
    agentType,
    description,
    JSON.stringify(serializeTaskMetadata(metadata)),
    null,
    description
  );

  logger.info({ workflowId, taskId: fullTaskId, agentType }, 'Added todo task');

  return {
    task_id: fullTaskId,
    description,
    agent_type: agentType,
    depends_on: resolvedDeps,
    status: 'pending',
    origin: metadata.origin,
    semantic_key: metadata.semantic_key ?? undefined,
    output_artifact: metadata.output_artifact ?? undefined,
    reason_generated: metadata.reason_generated ?? undefined,
    supersedes_task_id: metadata.supersedes_task_id ?? undefined,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

/**
 * Update the status of a task.
 * Persists to database.
 */
export async function updateTodoTaskStatus(
  workflowId: string,
  taskId: string,
  status: TodoTask['status'],
  output?: string
): Promise<void> {
  const db = getDb();
  
  const fullTaskId = taskId.startsWith(`${workflowId}_`) ? taskId : `${workflowId}_${taskId}`;
  
  logger.debug({ workflowId, taskId: fullTaskId, status }, 'updateTodoTaskStatus called');
  
  const sets = ['status = ?', "updated_at = datetime('now')"];
  const params: unknown[] = [status];

  if (status === 'running') {
    sets.push("started_at = datetime('now')");
  }
  if (status === 'completed' || status === 'failed') {
    sets.push("completed_at = datetime('now')");
  }
  if (output !== undefined) {
    sets.push('output = ?');
    params.push(output.substring(0, 10000)); // Limit output size
  }

  params.push(fullTaskId);
  params.push(workflowId);

  try {
    const result = db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ? AND workflow_id = ?`).run(...params);
    logger.debug({ workflowId, taskId: fullTaskId, status, changes: result.changes }, 'Updated todo task status');
  } catch (error) {
    logger.error({ workflowId, taskId: fullTaskId, status, error: (error as Error).message }, 'Failed to update todo task status');
    throw error;
  }
}

/**
 * Mark a task as skipped with a reason.
 */
export async function skipTodoTask(
  workflowId: string,
  taskId: string,
  reason: string
): Promise<void> {
  await updateTodoTaskStatus(workflowId, taskId, 'skipped', `[skipped: ${reason}]`);
  logger.info({ workflowId, taskId, reason }, 'Skipped todo task');
}

/**
 * Format the todo list for inclusion in the orchestrator system prompt.
 */
export function formatTodoListForPrompt(todoList: TodoList, maxOutputLength: number = 2000): string {
  const lines: string[] = [];
  
  lines.push('## Current Task List');
  lines.push(`Total: ${todoList.tasks.length} tasks | Completed: ${todoList.completed_count} | Pending: ${todoList.pending_count} | Failed: ${todoList.failed_count}`);
  lines.push('');

  for (const task of todoList.tasks) {
    const depsDisplay = task.depends_on.length > 0 
      ? ` [depends: ${task.depends_on.join(', ')}]`
      : '';
    
    lines.push(`- **${task.task_id}** (${task.agent_type}) [${task.status}]${depsDisplay}: ${task.description}`);
    lines.push(`  Metadata: origin=${task.origin}${task.output_artifact ? `, artifact=${task.output_artifact}` : ''}${task.reason_generated ? `, reason=${task.reason_generated}` : ''}${task.supersedes_task_id ? `, supersedes=${task.supersedes_task_id}` : ''}`);
    
    // Include output preview for completed/failed tasks
    if (task.output && (task.status === 'completed' || task.status === 'failed')) {
      const preview = task.output.length > maxOutputLength 
        ? task.output.substring(0, maxOutputLength) + '\n[...truncated...]'
        : task.output;
      lines.push(`  Output: ${preview.replace(/\n/g, ' ')}`);
    }
  }

  return lines.join('\n');
}

function serializeTaskMetadata(metadata: TaskMetadata): TaskMetadata {
  return {
    origin: metadata.origin,
    semantic_key: metadata.semantic_key ?? null,
    output_artifact: metadata.output_artifact ?? null,
    reason_generated: metadata.reason_generated ?? null,
    supersedes_task_id: metadata.supersedes_task_id ?? null,
  };
}

function parseTaskMetadata(modelValue: string | null, toolsValue: string | null): TaskMetadata {
  const fallback: TaskMetadata = { origin: 'planned' };

  const rawValue = toolsValue ?? modelValue;

  if (!rawValue) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(rawValue) as Partial<TaskMetadata> | string;
    if (!parsed || typeof parsed !== 'object') {
      return fallback;
    }

    return {
      origin: parsed.origin === 'runtime_generated' ? 'runtime_generated' : 'planned',
      semantic_key: typeof parsed.semantic_key === 'string' ? parsed.semantic_key : undefined,
      output_artifact: typeof parsed.output_artifact === 'string' ? parsed.output_artifact : undefined,
      reason_generated: typeof parsed.reason_generated === 'string' ? parsed.reason_generated : undefined,
      supersedes_task_id: typeof parsed.supersedes_task_id === 'string' ? parsed.supersedes_task_id : undefined,
    };
  } catch {
    logger.debug({ rawValue }, 'Ignoring task metadata parse failure; using defaults');
    return fallback;
  }
}

/**
 * Get tasks that are ready to execute (dependencies satisfied).
 */
export function getReadyTasks(todoList: TodoList): TodoTask[] {
  return todoList.tasks.filter(task => {
    if (task.status !== 'pending') return false;
    
    // Check all dependencies are completed or skipped
    return task.depends_on.every(depId => {
      const dep = todoList.tasks.find(t => t.task_id === depId);
      return dep?.status === 'completed' || dep?.status === 'skipped';
    });
  });
}

/**
 * Check if all tasks are settled (completed, failed, or skipped).
 */
export function allTasksSettled(todoList: TodoList): boolean {
  return todoList.tasks.every(t => 
    t.status === 'completed' || t.status === 'failed' || t.status === 'skipped'
  );
}
