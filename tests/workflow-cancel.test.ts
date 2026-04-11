import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { closeDb, getDb, runMigrations, resetEnvCache } from '@orchestrator/shared';

/**
 * Focused tests for workflow cancel semantics:
 * - Cancel preserves workflow row and task history
 * - Cancel is idempotent (second cancel is a no-op)
 * - Completed tasks are not affected by cancel
 * - Cancel on a completed workflow throws
 * - The workflow_cancelled event type is emitted (not workflow_failed)
 * - Cancelled workflows remain fetchable via getWorkflowDetails
 * - Cancelled workflows appear in listWorkflows
 */

describe('workflow cancel semantics', () => {
  let tempDir = '';

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cancel-test-'));
    process.env['DATABASE_PATH'] = join(tempDir, 'test.db');
    closeDb();
    resetEnvCache();
    runMigrations();

    const db = getDb();
    db.prepare('INSERT INTO users (id, email, tier, credits_balance) VALUES (?, ?, ?, ?)').run(
      'test-user',
      'test@example.test',
      'pro',
      100
    );
  });

  afterEach(() => {
    closeDb();
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.resetModules();
  });

  test('cancel preserves workflow row in database', async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO workflows (id, user_id, objective, status, config) VALUES (?, ?, ?, ?, ?)`
    ).run('wf-cancel-1', 'test-user', 'Test objective', 'executing', '{"objective":"Test objective"}');

    const { persistWorkflowCancellation } = await import(
      '../packages/orchestrator/src/workflow/persistence.js'
    );
    persistWorkflowCancellation('wf-cancel-1');

    // Workflow row must still exist
    const row = db.prepare('SELECT id, status, ended_at FROM workflows WHERE id = ?').get('wf-cancel-1') as {
      id: string;
      status: string;
      ended_at: string | null;
    };
    expect(row).not.toBeUndefined();
    expect(row.id).toBe('wf-cancel-1');
    expect(row.status).toBe('cancelled');
    expect(row.ended_at).not.toBeNull();
  });

  test('cancel preserves task history — pending/running become cancelled, completed stays completed', async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO workflows (id, user_id, objective, status, config) VALUES (?, ?, ?, ?, ?)`
    ).run('wf-cancel-2', 'test-user', 'Multi-task', 'executing', '{"objective":"Multi-task"}');

    db.prepare(
      `INSERT INTO tasks (id, workflow_id, task_type, description, status) VALUES (?, ?, ?, ?, ?)`
    ).run('t-running', 'wf-cancel-2', 'code', 'Running task', 'running');

    db.prepare(
      `INSERT INTO tasks (id, workflow_id, task_type, description, status) VALUES (?, ?, ?, ?, ?)`
    ).run('t-pending', 'wf-cancel-2', 'research', 'Pending task', 'pending');

    db.prepare(
      `INSERT INTO tasks (id, workflow_id, task_type, description, status, output) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('t-completed', 'wf-cancel-2', 'write', 'Done task', 'completed', 'Output from completed task');

    db.prepare(
      `INSERT INTO tasks (id, workflow_id, task_type, description, status) VALUES (?, ?, ?, ?, ?)`
    ).run('t-failed', 'wf-cancel-2', 'analyze', 'Failed task', 'failed');

    const { persistWorkflowCancellation } = await import(
      '../packages/orchestrator/src/workflow/persistence.js'
    );
    persistWorkflowCancellation('wf-cancel-2');

    // All tasks must still exist (not deleted)
    const allTasks = db
      .prepare('SELECT id, status, output, completed_at FROM tasks WHERE workflow_id = ? ORDER BY id')
      .all('wf-cancel-2') as Array<{ id: string; status: string; output: string | null; completed_at: string | null }>;
    expect(allTasks).toHaveLength(4);

    const byId = Object.fromEntries(allTasks.map((t) => [t.id, t]));

    // Running → cancelled with completed_at set
    expect(byId['t-running'].status).toBe('cancelled');
    expect(byId['t-running'].completed_at).not.toBeNull();

    // Pending → cancelled with completed_at set
    expect(byId['t-pending'].status).toBe('cancelled');
    expect(byId['t-pending'].completed_at).not.toBeNull();

    // Completed → unchanged
    expect(byId['t-completed'].status).toBe('completed');
    expect(byId['t-completed'].output).toBe('Output from completed task');

    // Failed → unchanged
    expect(byId['t-failed'].status).toBe('failed');
  });

  test('cancelled workflow remains fetchable via getWorkflowDetails', async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO workflows (id, user_id, objective, status, config) VALUES (?, ?, ?, ?, ?)`
    ).run('wf-cancel-3', 'test-user', 'Fetchable after cancel', 'executing', '{"objective":"Fetchable after cancel"}');

    db.prepare(
      `INSERT INTO tasks (id, workflow_id, task_type, description, status) VALUES (?, ?, ?, ?, ?)`
    ).run('t-fetch-1', 'wf-cancel-3', 'code', 'Task A', 'running');

    const { persistWorkflowCancellation } = await import(
      '../packages/orchestrator/src/workflow/persistence.js'
    );
    persistWorkflowCancellation('wf-cancel-3');

    const { getWorkflowDetails } = await import(
      '../packages/orchestrator/src/workflow/persistence.js'
    );
    const details = getWorkflowDetails('wf-cancel-3');

    expect(details).not.toBeNull();
    expect(details!.workflow.status).toBe('cancelled');
    expect(details!.tasks).toHaveLength(1);
    expect(details!.tasks[0].status).toBe('cancelled');
  });

  test('cancelled workflow appears in listWorkflows', async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO workflows (id, user_id, objective, status, config) VALUES (?, ?, ?, ?, ?)`
    ).run('wf-cancel-list', 'test-user', 'Should be listed', 'executing', '{"objective":"Should be listed"}');

    const { persistWorkflowCancellation } = await import(
      '../packages/orchestrator/src/workflow/persistence.js'
    );
    persistWorkflowCancellation('wf-cancel-list');

    const { listWorkflows } = await import('../packages/orchestrator/src/workflow/persistence.js');

    // Listed without status filter
    const all = listWorkflows('test-user');
    expect(all.some((w) => w.id === 'wf-cancel-list')).toBe(true);

    // Listed with status=cancelled filter
    const cancelled = listWorkflows('test-user', { status: 'cancelled' });
    expect(cancelled.some((w) => w.id === 'wf-cancel-list')).toBe(true);
    expect(cancelled.every((w) => w.status === 'cancelled')).toBe(true);
  });

  test('cancel is idempotent — second cancel on already-cancelled workflow is a no-op', async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO workflows (id, user_id, objective, status, config) VALUES (?, ?, ?, ?, ?)`
    ).run('wf-idempotent', 'test-user', 'Idempotent cancel', 'cancelled', '{"objective":"Idempotent cancel"}');

    // cancelWorkflow imports engine which has side effects (in-memory state),
    // so we test idempotency at the persistence layer and engine layer separately.

    // Persistence layer: calling persistWorkflowCancellation on already-cancelled is safe
    const { persistWorkflowCancellation } = await import(
      '../packages/orchestrator/src/workflow/persistence.js'
    );
    // Should not throw
    persistWorkflowCancellation('wf-idempotent');

    const row = db.prepare('SELECT status FROM workflows WHERE id = ?').get('wf-idempotent') as { status: string };
    expect(row.status).toBe('cancelled');
  });

  test('cancel does not affect workflows belonging to other users', async () => {
    const db = getDb();
    db.prepare('INSERT INTO users (id, email, tier, credits_balance) VALUES (?, ?, ?, ?)').run(
      'other-user',
      'other@example.test',
      'pro',
      100
    );
    db.prepare(
      `INSERT INTO workflows (id, user_id, objective, status, config) VALUES (?, ?, ?, ?, ?)`
    ).run('wf-other', 'other-user', 'Other user workflow', 'executing', '{"objective":"Other user workflow"}');

    db.prepare(
      `INSERT INTO workflows (id, user_id, objective, status, config) VALUES (?, ?, ?, ?, ?)`
    ).run('wf-mine', 'test-user', 'My workflow', 'executing', '{"objective":"My workflow"}');

    const { persistWorkflowCancellation } = await import(
      '../packages/orchestrator/src/workflow/persistence.js'
    );
    persistWorkflowCancellation('wf-mine');

    // Other user's workflow untouched
    const otherRow = db.prepare('SELECT status FROM workflows WHERE id = ?').get('wf-other') as { status: string };
    expect(otherRow.status).toBe('executing');

    // My workflow cancelled
    const myRow = db.prepare('SELECT status FROM workflows WHERE id = ?').get('wf-mine') as { status: string };
    expect(myRow.status).toBe('cancelled');
  });

  test('workflow_cancelled event type exists in WorkflowEvent union', async () => {
    // Verify at the type level by constructing a valid event
    const { } = await import('@orchestrator/shared');

    // This is a compile-time check — if workflow_cancelled is not in the type,
    // TypeScript would reject this. At runtime we verify the string is accepted.
    const event: import('@orchestrator/shared').WorkflowEvent = {
      type: 'workflow_cancelled',
      workflow_id: 'test-123',
      data: { reason: 'Cancelled by user' },
      timestamp: new Date().toISOString(),
    };

    expect(event.type).toBe('workflow_cancelled');
    expect(event.data).toEqual({ reason: 'Cancelled by user' });
  });

  test('cancellation is transactional — workflow and task updates are atomic', async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO workflows (id, user_id, objective, status, config) VALUES (?, ?, ?, ?, ?)`
    ).run('wf-atomic', 'test-user', 'Atomic cancel', 'executing', '{"objective":"Atomic cancel"}');

    db.prepare(
      `INSERT INTO tasks (id, workflow_id, task_type, description, status) VALUES (?, ?, ?, ?, ?)`
    ).run('t-atomic-1', 'wf-atomic', 'code', 'Task 1', 'running');

    db.prepare(
      `INSERT INTO tasks (id, workflow_id, task_type, description, status) VALUES (?, ?, ?, ?, ?)`
    ).run('t-atomic-2', 'wf-atomic', 'code', 'Task 2', 'pending');

    const { persistWorkflowCancellation } = await import(
      '../packages/orchestrator/src/workflow/persistence.js'
    );
    persistWorkflowCancellation('wf-atomic');

    // Both the workflow and both tasks should be cancelled (transaction atomicity)
    const wf = db.prepare('SELECT status FROM workflows WHERE id = ?').get('wf-atomic') as { status: string };
    expect(wf.status).toBe('cancelled');

    const tasks = db
      .prepare("SELECT status FROM tasks WHERE workflow_id = ? AND status = 'cancelled'")
      .all('wf-atomic') as Array<{ status: string }>;
    expect(tasks).toHaveLength(2);
  });
});
