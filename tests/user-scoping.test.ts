import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { closeDb, getDb, runMigrations, resetEnvCache } from '@orchestrator/shared';
import {
  clearUserRuntimeModelConfig,
  getRuntimeModelConfig,
  getSkillByIdForUser,
  getAllSkillsForUser,
  resolveOrchestratorModel,
  saveUserRuntimeModelConfig,
  upsertSkillForUser,
} from '@orchestrator/model-router';

describe('user-scoped skills and model preferences', () => {
  let tempDir = '';

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'user-scope-test-'));
    process.env['DATABASE_PATH'] = join(tempDir, 'test.db');
    closeDb();
    resetEnvCache();
    runMigrations();

    const db = getDb();
    db.prepare('INSERT INTO users (id, email, tier, credits_balance) VALUES (?, ?, ?, ?)').run(
      'user-a',
      'user-a@example.test',
      'pro',
      100
    );
    db.prepare('INSERT INTO users (id, email, tier, credits_balance) VALUES (?, ?, ?, ?)').run(
      'user-b',
      'user-b@example.test',
      'pro',
      100
    );
  });

  afterEach(() => {
    closeDb();
    resetEnvCache();
    delete process.env['DATABASE_PATH'];
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('skills are isolated per user', () => {
    upsertSkillForUser('user-a', 'code-review', {
      description: 'User A review style',
      prompt_addendum: 'Focus on readability and tests.',
      tools: [{ type: 'file_read' }, { type: 'grep' }],
    });

    const userASkill = getSkillByIdForUser('user-a', 'code-review');
    const userBSkill = getSkillByIdForUser('user-b', 'code-review');

    expect(userASkill?.description).toContain('User A');
    expect(userBSkill).toBeNull();

    const userASkills = getAllSkillsForUser('user-a');
    const userBSkills = getAllSkillsForUser('user-b');

    expect(userASkills.some((skill) => skill.id === 'code-review')).toBe(true);
    expect(userBSkills.some((skill) => skill.id === 'code-review')).toBe(false);
  });

  test('model preferences are isolated per user', () => {
    saveUserRuntimeModelConfig('user-a', {
      orchestrator_models: ['litellm/gemini-3-flash-preview'],
      default_orchestrator_model: 'litellm/gemini-3-flash-preview',
      agent_models: {
        research: 'litellm/gemini-3-flash-preview',
      },
    });

    const userAConfig = getRuntimeModelConfig('user-a');
    const userBConfig = getRuntimeModelConfig('user-b');

    expect(userAConfig.default_orchestrator_model).toBe('litellm/gemini-3-flash-preview');
    expect(userAConfig.orchestrator_models).toEqual(['litellm/gemini-3-flash-preview']);

    expect(userBConfig.default_orchestrator_model).not.toBe('litellm/gemini-3-flash-preview');

    expect(resolveOrchestratorModel(undefined, 'user-a')).toBe('litellm/gemini-3-flash-preview');

    clearUserRuntimeModelConfig('user-a');
    const resetConfig = getRuntimeModelConfig('user-a');
    expect(resetConfig.default_orchestrator_model).toBe(getRuntimeModelConfig().default_orchestrator_model);
  });
});
