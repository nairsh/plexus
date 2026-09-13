import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { closeDb, getDb, runMigrations } from '@orchestrator/shared';
import { getUsageSummary } from '../packages/billing/src/usage.js';

const USER_ID = 'test-user-usage';
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'usage-test-'));
  process.env['DATABASE_PATH'] = join(tempDir, 'test.db');
  runMigrations();

  const db = getDb();
  db.prepare(`INSERT INTO users (id, email, tier, credits_balance) VALUES (?, ?, ?, ?)`).run(
    USER_ID,
    'usage@test.local',
    'pro',
    10000
  );

  // Insert test credit transactions directly
  // Insert another user so FK constraints pass
  db.prepare(`INSERT INTO users (id, email, tier, credits_balance) VALUES (?, ?, ?, ?)`).run(
    'other-user',
    'other@test.local',
    'pro',
    10000
  );

  const insert = db.prepare(
    `INSERT INTO credit_transactions (id, user_id, amount, balance_after, description, reference_type, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  insert.run(
    't1',
    USER_ID,
    -10,
    9990,
    'LLM request',
    'workflow',
    JSON.stringify({ model: 'gpt-4o', total_tokens: 500 }),
    '2026-01-15 10:00:00'
  );
  insert.run(
    't2',
    USER_ID,
    -5,
    9985,
    'LLM request',
    'workflow',
    JSON.stringify({ model: 'gpt-4o', total_tokens: 200 }),
    '2026-01-20 10:00:00'
  );
  insert.run(
    't3',
    USER_ID,
    -8,
    9977,
    'LLM request',
    'workflow',
    JSON.stringify({ model: 'claude-3-5-sonnet', total_tokens: 400 }),
    '2026-01-25 10:00:00'
  );
  insert.run('t4', USER_ID, 100, 10077, 'Top-up', 'topup', null, '2026-01-01 10:00:00');
  insert.run(
    't5',
    'other-user',
    -20,
    9980,
    'LLM request',
    'workflow',
    JSON.stringify({ model: 'gpt-4o', total_tokens: 1000 }),
    '2026-01-15 10:00:00'
  );
});

afterEach(() => {
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('getUsageSummary', () => {
  test('sums total cost and request count for user (debits only)', () => {
    const summary = getUsageSummary(USER_ID);
    expect(summary.total_cost).toBeCloseTo(23); // 10 + 5 + 8
    expect(summary.total_requests).toBe(3);
  });

  test('groups by model correctly', () => {
    const summary = getUsageSummary(USER_ID);
    expect(summary.by_model['gpt-4o']).toBeDefined();
    expect(summary.by_model['gpt-4o'].requests).toBe(2);
    expect(summary.by_model['gpt-4o'].cost).toBeCloseTo(15);
    expect(summary.by_model['gpt-4o'].tokens).toBe(700);

    expect(summary.by_model['claude-3-5-sonnet']).toBeDefined();
    expect(summary.by_model['claude-3-5-sonnet'].requests).toBe(1);
    expect(summary.by_model['claude-3-5-sonnet'].cost).toBeCloseTo(8);
    expect(summary.by_model['claude-3-5-sonnet'].tokens).toBe(400);
  });

  test('does not include other users data', () => {
    const summary = getUsageSummary(USER_ID);
    expect(summary.total_cost).toBeCloseTo(23);
  });

  test('respects date range filter', () => {
    const summary = getUsageSummary(USER_ID, '2026-01-20', '2026-01-31');
    expect(summary.total_requests).toBe(2); // t2 and t3
    expect(summary.total_cost).toBeCloseTo(13);
  });

  test('returns zeros for unknown user', () => {
    const summary = getUsageSummary('nonexistent-user');
    expect(summary.total_cost).toBe(0);
    expect(summary.total_requests).toBe(0);
    expect(Object.keys(summary.by_model)).toHaveLength(0);
  });
});
