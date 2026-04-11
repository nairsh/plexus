import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { closeDb, getDb, runMigrations, resetEnvCache, BashApprovalSchema } from '@orchestrator/shared';

describe('schema validation edge cases', () => {
  let tempDir = '';

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'schema-test-'));
    process.env['DATABASE_PATH'] = join(tempDir, 'test.db');
    closeDb();
    resetEnvCache();
    runMigrations();
  });

  afterEach(() => {
    closeDb();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('WorkflowConfigSchema rejects empty objective', async () => {
    const { WorkflowConfigSchema } = await import('@orchestrator/shared');
    const result = WorkflowConfigSchema.safeParse({ objective: '' });
    expect(result.success).toBe(false);
  });

  test('WorkflowConfigSchema rejects whitespace-only objective', async () => {
    const { WorkflowConfigSchema } = await import('@orchestrator/shared');
    const result = WorkflowConfigSchema.safeParse({ objective: '   ' });
    expect(result.success).toBe(false);
  });

  test('WorkflowConfigSchema accepts valid objective', async () => {
    const { WorkflowConfigSchema } = await import('@orchestrator/shared');
    const result = WorkflowConfigSchema.safeParse({ objective: 'Build a REST API' });
    expect(result.success).toBe(true);
    expect(result.data?.objective).toBe('Build a REST API');
  });

  test('WorkflowConfigSchema trims objective whitespace', async () => {
    const { WorkflowConfigSchema } = await import('@orchestrator/shared');
    const result = WorkflowConfigSchema.safeParse({ objective: '  Build a REST API  ' });
    expect(result.success).toBe(true);
    expect(result.data?.objective).toBe('Build a REST API');
  });

  test('WorkflowConfigSchema caps max_credits at 10000', async () => {
    const { WorkflowConfigSchema } = await import('@orchestrator/shared');
    const result = WorkflowConfigSchema.safeParse({ objective: 'test', max_credits: 20000 });
    expect(result.success).toBe(false);
  });

  test('WorkflowConfigSchema accepts valid max_credits', async () => {
    const { WorkflowConfigSchema } = await import('@orchestrator/shared');
    const result = WorkflowConfigSchema.safeParse({ objective: 'test', max_credits: 5 });
    expect(result.success).toBe(true);
    expect(result.data?.max_credits).toBe(5);
  });

  test('WorkflowConfigSchema validates callback_url format', async () => {
    const { WorkflowConfigSchema } = await import('@orchestrator/shared');
    const invalid = WorkflowConfigSchema.safeParse({ objective: 'test', callback_url: 'not-a-url' });
    expect(invalid.success).toBe(false);

    const valid = WorkflowConfigSchema.safeParse({ objective: 'test', callback_url: 'https://example.com/webhook' });
    expect(valid.success).toBe(true);
  });

  test('WorkflowConfigSchema rejects webhook_secret without callback_url', async () => {
    const { WorkflowConfigSchema } = await import('@orchestrator/shared');
    const result = WorkflowConfigSchema.safeParse({
      objective: 'test',
      webhook_secret: 'my-secret-key',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.errors.map((e) => e.path.join('.'));
      expect(paths).toContain('callback_url');
      expect(result.error.errors[0]?.message).toContain('callback_url is required');
    }
  });

  test('WorkflowConfigSchema accepts webhook_secret with callback_url', async () => {
    const { WorkflowConfigSchema } = await import('@orchestrator/shared');
    const result = WorkflowConfigSchema.safeParse({
      objective: 'test',
      webhook_secret: 'my-secret-key',
      callback_url: 'https://example.com/webhook',
    });
    expect(result.success).toBe(true);
    expect(result.data?.webhook_secret).toBe('my-secret-key');
    expect(result.data?.callback_url).toBe('https://example.com/webhook');
  });

  test('WorkflowConfigSchema accepts callback_url without webhook_secret', async () => {
    const { WorkflowConfigSchema } = await import('@orchestrator/shared');
    const result = WorkflowConfigSchema.safeParse({
      objective: 'test',
      callback_url: 'https://example.com/webhook',
    });
    expect(result.success).toBe(true);
    expect(result.data?.webhook_secret).toBeUndefined();
  });

  test('WorkflowConfigSchema rejects empty-string webhook_secret', async () => {
    const { WorkflowConfigSchema } = await import('@orchestrator/shared');
    const result = WorkflowConfigSchema.safeParse({
      objective: 'test',
      webhook_secret: '',
      callback_url: 'https://example.com/webhook',
    });
    expect(result.success).toBe(false);
  });

  test('WorkflowConfigSchema accepts omitting both callback_url and webhook_secret', async () => {
    const { WorkflowConfigSchema } = await import('@orchestrator/shared');
    const result = WorkflowConfigSchema.safeParse({ objective: 'test' });
    expect(result.success).toBe(true);
    expect(result.data?.callback_url).toBeUndefined();
    expect(result.data?.webhook_secret).toBeUndefined();
  });

  test('WorkflowConfigSchema limits context_files count', async () => {
    const { WorkflowConfigSchema } = await import('@orchestrator/shared');
    const files = Array.from({ length: 25 }, (_, i) => ({
      filename: `file-${i}.txt`,
      content_base64: Buffer.from('hello').toString('base64'),
      media_type: 'text/plain',
    }));
    const result = WorkflowConfigSchema.safeParse({ objective: 'test', context_files: files });
    expect(result.success).toBe(false);
  });

  test('WorkflowConfigSchema accepts 20 context_files', async () => {
    const { WorkflowConfigSchema } = await import('@orchestrator/shared');
    const files = Array.from({ length: 20 }, (_, i) => ({
      filename: `file-${i}.txt`,
      content_base64: Buffer.from('hello').toString('base64'),
      media_type: 'text/plain',
    }));
    const result = WorkflowConfigSchema.safeParse({ objective: 'test', context_files: files });
    expect(result.success).toBe(true);
  });
});

describe('BashApprovalSchema', () => {
  test('accepts valid approve decision', () => {
    const result = BashApprovalSchema.safeParse({
      approval_id: 'abc-123',
      decision: 'approve',
    });
    expect(result.success).toBe(true);
  });

  test('accepts deny decision', () => {
    const result = BashApprovalSchema.safeParse({
      approval_id: 'abc-123',
      decision: 'deny',
    });
    expect(result.success).toBe(true);
  });

  test('rejects "reject" as decision (must use "deny")', () => {
    const result = BashApprovalSchema.safeParse({
      approval_id: 'abc-123',
      decision: 'reject',
    });
    expect(result.success).toBe(false);
  });

  test('rejects empty approval_id', () => {
    const result = BashApprovalSchema.safeParse({
      approval_id: '',
      decision: 'approve',
    });
    expect(result.success).toBe(false);
  });

  test('rejects missing approval_id', () => {
    const result = BashApprovalSchema.safeParse({
      decision: 'approve',
    });
    expect(result.success).toBe(false);
  });

  test('accepts approve_all_session decision', () => {
    const result = BashApprovalSchema.safeParse({
      approval_id: 'abc-123',
      decision: 'approve_all_session',
    });
    expect(result.success).toBe(true);
  });
});
