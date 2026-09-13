import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { closeDb, getDb, runMigrations, resetEnvCache } from '@orchestrator/shared';

// We test the webhook retry logic indirectly through the lifecycle module.
// Since fireWebhook is a private function, we test the exported completeWorkflow/failWorkflow
// and verify they emit the right events.

describe('workflow lifecycle', () => {
  let tempDir = '';

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'lifecycle-test-'));
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
  });

  test('persistWorkflowCancellation is atomic (workflow + tasks)', async () => {
    const db = getDb();

    // Create a workflow with tasks
    db.prepare(`INSERT INTO workflows (id, user_id, objective, status, config) VALUES (?, ?, ?, ?, ?)`).run(
      'wf-cancel',
      'test-user',
      'Cancel test',
      'executing',
      '{"objective":"cancel test"}'
    );

    db.prepare(`INSERT INTO tasks (id, workflow_id, task_type, description, status) VALUES (?, ?, ?, ?, ?)`).run(
      'task-1',
      'wf-cancel',
      'code',
      'Do something',
      'running'
    );

    db.prepare(`INSERT INTO tasks (id, workflow_id, task_type, description, status) VALUES (?, ?, ?, ?, ?)`).run(
      'task-2',
      'wf-cancel',
      'research',
      'Research something',
      'pending'
    );

    db.prepare(`INSERT INTO tasks (id, workflow_id, task_type, description, status) VALUES (?, ?, ?, ?, ?)`).run(
      'task-3',
      'wf-cancel',
      'code',
      'Already done',
      'completed'
    );

    // Import and call
    const { persistWorkflowCancellation } = await import('../packages/orchestrator/src/workflow/persistence.js');
    persistWorkflowCancellation('wf-cancel');

    // Verify workflow is cancelled
    const workflow = db.prepare('SELECT status, ended_at FROM workflows WHERE id = ?').get('wf-cancel') as {
      status: string;
      ended_at: string | null;
    };
    expect(workflow.status).toBe('cancelled');
    expect(workflow.ended_at).not.toBeNull();

    // Verify running/pending tasks are cancelled
    const task1 = db.prepare('SELECT status, completed_at FROM tasks WHERE id = ?').get('task-1') as {
      status: string;
      completed_at: string | null;
    };
    expect(task1.status).toBe('cancelled');
    expect(task1.completed_at).not.toBeNull();

    const task2 = db.prepare('SELECT status FROM tasks WHERE id = ?').get('task-2') as { status: string };
    expect(task2.status).toBe('cancelled');

    // Completed task should NOT be changed
    const task3 = db.prepare('SELECT status FROM tasks WHERE id = ?').get('task-3') as { status: string };
    expect(task3.status).toBe('completed');
  });

  test('persistWorkflowCompletion saves output to DB', async () => {
    const db = getDb();
    db.prepare(`INSERT INTO workflows (id, user_id, objective, status, config) VALUES (?, ?, ?, ?, ?)`).run(
      'wf-complete',
      'test-user',
      'Complete test',
      'executing',
      '{"objective":"complete test"}'
    );

    const { persistWorkflowCompletion } = await import('../packages/orchestrator/src/workflow/persistence.js');

    const mockState = {
      id: 'wf-complete',
      userId: 'test-user',
      status: 'completed',
      creditsConsumed: 0.5,
      lastOutput: 'This is the final output',
    };

    persistWorkflowCompletion(mockState as any, 'Explicit output text');

    const row = db.prepare('SELECT status, output FROM workflows WHERE id = ?').get('wf-complete') as {
      status: string;
      output: string | null;
    };
    expect(row.status).toBe('completed');
    expect(row.output).toBe('Explicit output text');
  });
});
