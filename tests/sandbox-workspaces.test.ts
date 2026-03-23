import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeDb, getDb, runMigrations } from '@orchestrator/shared';
import {
  activateWorkspace,
  deactivateWorkspace,
  ensureWorkspace,
  getWorkspaceInfo,
  readWorkspaceMetadata,
  snapshotWorkspaceFiles,
} from '../packages/sandbox/src/workspaces.js';

let tempDir: string;

describe('sandbox workspaces', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sandbox-workspace-'));
    process.env['DATABASE_PATH'] = join(tempDir, 'test.db');
    process.env['SANDBOX_WORKSPACE_ROOT'] = join(tempDir, 'workspaces');
    runMigrations();

    getDb().prepare('INSERT INTO users (id, email, tier, credits_balance) VALUES (?, ?, ?, ?)').run(
      'user-1',
      'sandbox@test.local',
      'pro',
      100
    );
  });

  afterEach(() => {
    closeDb();
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env['SANDBOX_WORKSPACE_ROOT'];
  });

  test('persists workspace metadata and files across deactivation', () => {
    const workspace = ensureWorkspace('user-1', 'chat-1', 'python');
    expect(existsSync(workspace.metadataPath)).toBe(true);

    writeFileSync(join(workspace.filesPath, 'existing.txt'), 'already here');

    getDb().prepare(
      `INSERT INTO sandbox_sessions (id, user_id, chat_id, language, working_dir, environment_status, status, config)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('session-1', 'user-1', 'chat-1', 'python', join(tempDir, 'session-files'), 'running', 'ready', '{}');

    const sessionDir = join(tempDir, 'session-files');
    const sessionFile = join(sessionDir, 'artifact.txt');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(sessionFile, 'hello workspace');

    activateWorkspace('user-1', 'chat-1', 'session-1', 'python', sessionDir);
    deactivateWorkspace('session-1', sessionDir, true);

    const info = getWorkspaceInfo('user-1', 'chat-1');
    const metadata = readWorkspaceMetadata('user-1', 'chat-1');
    expect(info?.['status']).toBe('inactive');
    expect(snapshotWorkspaceFiles(workspace.filesPath)).toContain('artifact.txt');
    expect(readFileSync(join(workspace.filesPath, 'artifact.txt'), 'utf-8')).toBe('hello workspace');
    expect(metadata?.['chat_id']).toBe('chat-1');
    expect(metadata?.['created_files']).toEqual(['artifact.txt']);
  });

  test('tracks created files for open terminal style sessions', () => {
    const workspace = ensureWorkspace('user-1', 'chat-2', 'python');
    writeFileSync(join(workspace.filesPath, 'existing.txt'), 'already here');

    const sessionDir = join(tempDir, 'session-files-open-terminal');
    mkdirSync(sessionDir, { recursive: true });

    getDb().prepare(
      `INSERT INTO sandbox_sessions (id, user_id, chat_id, language, working_dir, environment_status, status, config)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('session-2', 'user-1', 'chat-2', 'python', sessionDir, 'running', 'ready', '{}');

    activateWorkspace('user-1', 'chat-2', 'session-2', 'python', sessionDir);
    writeFileSync(join(workspace.filesPath, 'created-open-terminal.txt'), 'from open terminal');
    deactivateWorkspace('session-2', sessionDir, false);

    expect(snapshotWorkspaceFiles(workspace.filesPath)).toEqual(
      expect.arrayContaining(['existing.txt', 'created-open-terminal.txt'])
    );
    expect(readWorkspaceMetadata('user-1', 'chat-2')?.['created_files']).toEqual(['created-open-terminal.txt']);
  });
});
