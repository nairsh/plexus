import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeDb, getDb, runMigrations } from '@orchestrator/shared';
import { getOpenTerminalSessionForChat } from '@orchestrator/model-router';

let tempDir: string;

describe('workspace access', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'workspace-access-'));
    process.env['DATABASE_PATH'] = join(tempDir, 'test.db');
    runMigrations();

    const db = getDb();
    db.prepare('INSERT INTO users (id, email, tier, credits_balance) VALUES (?, ?, ?, ?)').run(
      'user-1',
      'workspace@test.local',
      'pro',
      100
    );
  });

  afterEach(() => {
    closeDb();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('uses persisted workspace root for local chat workspaces', async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO sandbox_sessions (
        id, task_id, user_id, chat_id, language, working_dir, open_terminal_url, open_terminal_api_key,
        environment_status, status, config
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'session-1',
      null,
      'user-1',
      'chat-1',
      'javascript',
      '/tmp/session-workspace',
      null,
      null,
      'running',
      'ready',
      '{}'
    );

    db.prepare(
      `INSERT INTO sandbox_workspaces (user_id, chat_id, active_session_id, language, workspace_path, metadata_path, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('user-1', 'chat-1', 'session-1', 'javascript', '/persistent/workspace', '/tmp/meta.json', 'active');

    const session = await getOpenTerminalSessionForChat('user-1', 'chat-1');

    expect(session).toMatchObject({
      baseUrl: '',
      workspacePath: '/persistent/workspace',
      workingDirectory: undefined,
    });
  });
});
