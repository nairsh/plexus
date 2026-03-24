import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { closeDb, getDb, runMigrations, resetEnvCache } from '@orchestrator/shared';

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
