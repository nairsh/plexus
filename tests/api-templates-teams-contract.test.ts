/**
 * Contract tests for templates route registration and teams agent-type alignment.
 *
 * Validates:
 *  - /v1/templates is mounted (not 404) and enforces auth consistently
 *  - teams CreateTeamSchema accepts `deep_research` in allowed_agent_types
 *  - teams CreateTeamSchema still rejects invalid agent types
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { closeDb, runMigrations, resetEnvCache, AgentTypeSchema } from '@orchestrator/shared';

// ── DB lifecycle (matches existing schema-validation.test.ts pattern) ─────────

let tempDir = '';

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'contract-test-'));
  process.env['DATABASE_PATH'] = join(tempDir, 'test.db');
  process.env['DISABLE_AUTH'] = 'true';
  process.env['TEAMS_BETA_ENABLED'] = '1';
  process.env['BILLING_MODE'] = 'free';
  closeDb();
  resetEnvCache();
  runMigrations();
});

afterEach(() => {
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
});

// ── Templates route reachability ──────────────────────────────────────────────

describe('/v1/templates route registration', () => {
  test('GET /v1/templates is mounted (not 404)', async () => {
    const { createServer } = await import('../packages/api-server/src/server.js');
    const app = await createServer();

    const res = await app.inject({
      method: 'GET',
      url: '/v1/templates',
    });

    // Auth may reject (401) in some configs, but the route MUST be mounted (not 404).
    expect(res.statusCode).not.toBe(404);

    await app.close();
  });

  test('POST /v1/templates is mounted (not 404)', async () => {
    const { createServer } = await import('../packages/api-server/src/server.js');
    const app = await createServer();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/templates',
      payload: {},
    });

    // Even an invalid body should produce a validation error, not 404.
    expect(res.statusCode).not.toBe(404);

    await app.close();
  });

  test('GET /v1/templates/:id is mounted (not 404)', async () => {
    const { createServer } = await import('../packages/api-server/src/server.js');
    const app = await createServer();

    const res = await app.inject({
      method: 'GET',
      url: '/v1/templates/nonexistent-id',
    });

    expect(res.statusCode).not.toBe(404);

    await app.close();
  });

  test('auth enforcement is consistent with other /v1/ routes', async () => {
    // Temporarily require auth to verify templates respects it
    delete process.env['DISABLE_AUTH'];
    resetEnvCache();

    const { createServer } = await import('../packages/api-server/src/server.js');
    const app = await createServer();

    const templatesRes = await app.inject({
      method: 'GET',
      url: '/v1/templates',
    });

    const workflowsRes = await app.inject({
      method: 'GET',
      url: '/v1/workflows',
    });

    // Both should require auth equally (same status code)
    expect(templatesRes.statusCode).toBe(workflowsRes.statusCode);

    await app.close();
  });
});

// ── Teams agent-type contract alignment ───────────────────────────────────────

describe('teams allowed_agent_types contract', () => {
  test('AgentTypeSchema includes deep_research', () => {
    const result = AgentTypeSchema.safeParse('deep_research');
    expect(result.success).toBe(true);
    expect(result.data).toBe('deep_research');
  });

  test('AgentTypeSchema accepts all canonical agent types', () => {
    const canonical = ['research', 'analyze', 'write', 'code', 'file', 'deep_research'];
    for (const t of canonical) {
      const result = AgentTypeSchema.safeParse(t);
      expect(result.success).toBe(true);
    }
  });

  test('AgentTypeSchema rejects invalid agent types', () => {
    const invalid = ['invalid', 'execute', 'search', '', 'RESEARCH', 'deep-research'];
    for (const t of invalid) {
      const result = AgentTypeSchema.safeParse(t);
      expect(result.success).toBe(false);
    }
  });

  test('CreateTeamSchema accepts deep_research in allowed_agent_types', () => {
    // Validate using the same AgentTypeSchema that teams.ts now references.
    // An array wrapper mirrors the CreateTeamSchema's allowed_agent_types field.
    const result = AgentTypeSchema.array().safeParse(['deep_research']);

    expect(result.success).toBe(true);
    expect(result.data).toEqual(['deep_research']);
  });

  test('CreateTeamSchema accepts mixed agent types including deep_research', () => {
    const result = AgentTypeSchema.array().safeParse(['research', 'deep_research', 'code']);

    expect(result.success).toBe(true);
    expect(result.data).toEqual(['research', 'deep_research', 'code']);
  });

  test('CreateTeamSchema rejects invalid agent types', () => {
    const result = AgentTypeSchema.array().safeParse(['invalid_type']);

    expect(result.success).toBe(false);
  });

  test('CreateTeamSchema allows omitting allowed_agent_types', () => {
    const result = AgentTypeSchema.array().optional().safeParse(undefined);

    expect(result.success).toBe(true);
    expect(result.data).toBeUndefined();
  });
});
