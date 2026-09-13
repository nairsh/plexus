import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { closeDb, getDb, runMigrations, resetEnvCache } from '@orchestrator/shared';

describe('workflow state management', () => {
  let tempDir = '';

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'wfstate-test-'));
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
  });

  test('countWorkflows returns 0 for user with no workflows', async () => {
    const { countWorkflows } = await import('@orchestrator/orchestrator');
    expect(countWorkflows('test-user')).toBe(0);
  });

  test('countWorkflows returns 0 for non-existent user', async () => {
    const { countWorkflows } = await import('@orchestrator/orchestrator');
    expect(countWorkflows('non-existent-user')).toBe(0);
  });

  test('listWorkflows returns empty array for user with no workflows', async () => {
    const { listWorkflows } = await import('@orchestrator/orchestrator');
    expect(listWorkflows('test-user')).toEqual([]);
  });

  test('listWorkflows with invalid status returns empty', async () => {
    const { listWorkflows } = await import('@orchestrator/orchestrator');
    const db = getDb();
    db.prepare(`INSERT INTO workflows (id, user_id, objective, status, config) VALUES (?, ?, ?, ?, ?)`).run(
      'wf-1',
      'test-user',
      'Test',
      'completed',
      '{"objective":"test"}'
    );

    expect(listWorkflows('test-user', { status: 'nonexistent' as any })).toEqual([]);
  });

  test('persistWorkflowStatus updates status and pause_reason', async () => {
    const { persistWorkflowStatus } = await import('../packages/orchestrator/src/workflow/persistence.js');
    const db = getDb();

    db.prepare(`INSERT INTO workflows (id, user_id, objective, status, config) VALUES (?, ?, ?, ?, ?)`).run(
      'wf-pause',
      'test-user',
      'Test',
      'executing',
      '{"objective":"test"}'
    );

    persistWorkflowStatus('wf-pause', 'paused', 'Waiting for user clarification');

    const row = db.prepare('SELECT status, pause_reason FROM workflows WHERE id = ?').get('wf-pause') as {
      status: string;
      pause_reason: string | null;
    };
    expect(row.status).toBe('paused');
    expect(row.pause_reason).toBe('Waiting for user clarification');
  });

  test('persistWorkflowStatus clears pause_reason when resuming', async () => {
    const { persistWorkflowStatus } = await import('../packages/orchestrator/src/workflow/persistence.js');
    const db = getDb();

    db.prepare(
      `INSERT INTO workflows (id, user_id, objective, status, config, pause_reason) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('wf-resume', 'test-user', 'Test', 'paused', '{"objective":"test"}', 'Some question');

    persistWorkflowStatus('wf-resume', 'executing');

    const row = db.prepare('SELECT status, pause_reason FROM workflows WHERE id = ?').get('wf-resume') as {
      status: string;
      pause_reason: string | null;
    };
    expect(row.status).toBe('executing');
    expect(row.pause_reason).toBeNull();
  });

  test('persistWorkflowFailure records error message', async () => {
    const { persistWorkflowFailure } = await import('../packages/orchestrator/src/workflow/persistence.js');
    const db = getDb();

    db.prepare(`INSERT INTO workflows (id, user_id, objective, status, config) VALUES (?, ?, ?, ?, ?)`).run(
      'wf-fail',
      'test-user',
      'Test',
      'executing',
      '{"objective":"test"}'
    );

    const mockState = { id: 'wf-fail', creditsConsumed: 1.23 };
    persistWorkflowFailure(mockState as any, 'Out of memory');

    const row = db.prepare('SELECT status, error FROM workflows WHERE id = ?').get('wf-fail') as {
      status: string;
      error: string | null;
    };
    expect(row.status).toBe('failed');
    expect(row.error).toBe('Out of memory');
  });
});
