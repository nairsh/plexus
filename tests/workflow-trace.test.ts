import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeDb, getDb, runMigrations } from '@orchestrator/shared';
import { getWorkflowTrace } from '@orchestrator/orchestrator';
import { logWorkflowStep } from '../packages/orchestrator/src/workflowTrace.js';

let tempDir: string;

describe('workflow trace', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'workflow-trace-'));
    process.env['DATABASE_PATH'] = join(tempDir, 'test.db');
    runMigrations();

    const db = getDb();
    db.prepare('INSERT INTO users (id, email, tier, credits_balance) VALUES (?, ?, ?, ?)').run(
      'user-1',
      'trace@test.local',
      'pro',
      100
    );
    db.prepare(
      "INSERT INTO workflows (id, user_id, objective, user_prompt, orchestrator_model, status, config, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))"
    ).run('wf-1', 'user-1', 'trace objective', 'trace objective', 'litellm/gemini-3-flash-preview', 'executing', '{}');
  });

  afterEach(() => {
    closeDb();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('returns chronological workflow steps', () => {
    logWorkflowStep({
      workflow_id: 'wf-1',
      step_type: 'orchestrator_message',
      model_name: 'litellm/gemini-3-flash-preview',
      message_content: 'start planning',
    });
    logWorkflowStep({
      workflow_id: 'wf-1',
      step_type: 'tool_result',
      tool_name: 'search_web',
      tool_input: { query: 'orchestrator platform' },
      tool_output: { provider: 'tavily', results: [] },
    });

    const trace = getWorkflowTrace('wf-1');
    expect(trace).toHaveLength(2);
    expect(trace[0]?.step_type).toBe('orchestrator_message');
    expect(trace[1]?.tool_name).toBe('search_web');
    expect(trace[1]?.tool_output).toEqual({ provider: 'tavily', results: [] });
  });
});
