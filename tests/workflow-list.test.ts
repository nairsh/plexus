import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { closeDb, getDb, runMigrations, resetEnvCache } from '@orchestrator/shared';
import { listWorkflows, countWorkflows } from '@orchestrator/orchestrator';

describe('workflow listing and filtering', () => {
  let tempDir = '';
  const userId = 'test-user-wf';

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'wflist-test-'));
    process.env['DATABASE_PATH'] = join(tempDir, 'test.db');
    closeDb();
    resetEnvCache();
    runMigrations();

    const db = getDb();
    db.prepare('INSERT INTO users (id, email, tier, credits_balance) VALUES (?, ?, ?, ?)').run(
      userId, 'wftest@example.test', 'pro', 100
    );

    // Insert sample workflows
    const statuses = ['executing', 'completed', 'completed', 'failed', 'paused'];
    for (let i = 0; i < statuses.length; i++) {
      db.prepare(
        `INSERT INTO workflows (id, user_id, objective, status, config)
         VALUES (?, ?, ?, ?, ?)`
      ).run(`wf-${i}`, userId, `Test workflow ${i}`, statuses[i], JSON.stringify({ objective: `Test workflow ${i}` }));
    }
  });

  afterEach(() => {
    closeDb();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('listWorkflows returns all workflows for user', () => {
    const all = listWorkflows(userId);
    expect(all.length).toBe(5);
  });

  test('listWorkflows filters by status', () => {
    const completed = listWorkflows(userId, { status: 'completed' });
    expect(completed.length).toBe(2);
    expect(completed.every((w) => w.status === 'completed')).toBe(true);
  });

  test('listWorkflows respects limit', () => {
    const limited = listWorkflows(userId, { limit: 2 });
    expect(limited.length).toBe(2);
  });

  test('listWorkflows respects offset', () => {
    const page1 = listWorkflows(userId, { limit: 2, offset: 0 });
    const page2 = listWorkflows(userId, { limit: 2, offset: 2 });

    expect(page1.length).toBe(2);
    expect(page2.length).toBe(2);

    const ids1 = page1.map((w) => w.id);
    const ids2 = page2.map((w) => w.id);
    expect(ids1.some((id) => ids2.includes(id))).toBe(false);
  });

  test('listWorkflows filters by status and applies limit', () => {
    const result = listWorkflows(userId, { status: 'completed', limit: 1 });
    expect(result.length).toBe(1);
    expect(result[0]!.status).toBe('completed');
  });

  test('countWorkflows counts all workflows', () => {
    expect(countWorkflows(userId)).toBe(5);
  });

  test('countWorkflows counts by status', () => {
    expect(countWorkflows(userId, 'completed')).toBe(2);
    expect(countWorkflows(userId, 'failed')).toBe(1);
    expect(countWorkflows(userId, 'executing')).toBe(1);
    expect(countWorkflows(userId, 'paused')).toBe(1);
  });

  test('countWorkflows returns 0 for unknown status', () => {
    expect(countWorkflows(userId, 'cancelled')).toBe(0);
  });

  test('listWorkflows does not return other users workflows', () => {
    const db = getDb();
    db.prepare('INSERT INTO users (id, email, tier, credits_balance) VALUES (?, ?, ?, ?)').run(
      'other-user', 'other@example.test', 'free', 10
    );
    db.prepare(
      `INSERT INTO workflows (id, user_id, objective, status, config)
       VALUES (?, ?, ?, ?, ?)`
    ).run('wf-other', 'other-user', 'Other user workflow', 'completed', '{"objective":"other"}');

    const myWorkflows = listWorkflows(userId);
    expect(myWorkflows.length).toBe(5);
    expect(myWorkflows.every((w) => w.id.startsWith('wf-'))).toBe(true);
    expect(myWorkflows.find((w) => w.id === 'wf-other')).toBeUndefined();
  });
});
