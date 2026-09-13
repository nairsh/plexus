import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createGitSandbox, rollbackGitSandbox, commitGitSandbox, GitOperationError } from '@orchestrator/sandbox';
import { closeDb, getDb, runMigrations } from '@orchestrator/shared';

function gitSync(cwd: string, ...args: string[]): string {
  return execSync('git ' + args.join(' '), { cwd, encoding: 'utf-8' }).trim();
}

function initRepo(dir: string, branchName = 'main'): string {
  execSync('git init -b ' + branchName, { cwd: dir });
  execSync('git config user.email "test@test.test"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# test\n');
  execSync('git add .', { cwd: dir });
  execSync('git commit -m "initial"', { cwd: dir });
  return gitSync(dir, 'rev-parse', 'HEAD');
}

let tempDir: string;
let repoDir: string;

beforeEach(() => {
  tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'git-sandbox-test-')));
  repoDir = join(tempDir, 'repo');
  execSync('mkdir -p ' + repoDir);
  process.env['DATABASE_PATH'] = join(tempDir, 'test.db');
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('createGitSandbox', () => {
  test('persists baseBranch in DB and returns it on the session', async () => {
    initRepo(repoDir, 'develop');
    const session = await createGitSandbox('wf-001', repoDir);
    expect(session).not.toBeNull();
    expect(session!.baseBranch).toBe('develop');
    const db = getDb();
    const row = db.prepare('SELECT base_branch FROM git_snapshots WHERE id = ?').get(session!.id) as {
      base_branch: string;
    };
    expect(row.base_branch).toBe('develop');
  });

  test('creates sandbox branch and switches to it', async () => {
    initRepo(repoDir, 'main');
    const session = await createGitSandbox('wf-002', repoDir);
    expect(session).not.toBeNull();
    const currentBranch = gitSync(repoDir, 'rev-parse', '--abbrev-ref', 'HEAD');
    expect(currentBranch).toBe(session!.branchName);
  });

  test('returns null for non-git directories', async () => {
    const session = await createGitSandbox('wf-003', repoDir);
    expect(session).toBeNull();
  });

  test('returns null for non-existent directories', async () => {
    const session = await createGitSandbox('wf-004', join(tempDir, 'nonexistent'));
    expect(session).toBeNull();
  });
});

describe('rollbackGitSandbox', () => {
  test('restores checkout to the recorded original branch', async () => {
    initRepo(repoDir, 'feature-x');
    const session = await createGitSandbox('wf-010', repoDir);
    expect(session).not.toBeNull();
    writeFileSync(join(repoDir, 'agent-file.txt'), 'agent wrote this');
    execSync('git add . && git commit -m "agent work"', { cwd: repoDir });
    const result = await rollbackGitSandbox(session!.id);
    expect(result.success).toBe(true);
    const branch = gitSync(repoDir, 'rev-parse', '--abbrev-ref', 'HEAD');
    expect(branch).toBe('feature-x');
  });

  test('does NOT hard-reset the users original branch', async () => {
    initRepo(repoDir, 'main');
    writeFileSync(join(repoDir, 'user-file.txt'), 'user work');
    execSync('git add . && git commit -m "user commit"', { cwd: repoDir });
    const userCommit = gitSync(repoDir, 'rev-parse', 'HEAD');
    const session = await createGitSandbox('wf-011', repoDir);
    expect(session).not.toBeNull();
    expect(session!.baseCommit).toBe(userCommit);
    writeFileSync(join(repoDir, 'agent-file.txt'), 'agent wrote this');
    execSync('git add . && git commit -m "agent work"', { cwd: repoDir });
    const result = await rollbackGitSandbox(session!.id);
    expect(result.success).toBe(true);
    const mainHead = gitSync(repoDir, 'rev-parse', 'HEAD');
    expect(mainHead).toBe(userCommit);
  });

  test('deletes the sandbox branch after rollback', async () => {
    initRepo(repoDir, 'main');
    const session = await createGitSandbox('wf-012', repoDir);
    expect(session).not.toBeNull();
    const result = await rollbackGitSandbox(session!.id);
    expect(result.success).toBe(true);
    const branches = gitSync(repoDir, 'branch', '--list');
    expect(branches).not.toContain(session!.branchName);
  });

  test('rejects rollback of non-active (committed) sandbox', async () => {
    initRepo(repoDir, 'main');
    const session = await createGitSandbox('wf-013', repoDir);
    expect(session).not.toBeNull();
    writeFileSync(join(repoDir, 'file.txt'), 'data');
    await commitGitSandbox(session!.id, 'commit agent work');
    const result = await rollbackGitSandbox(session!.id);
    expect(result.success).toBe(false);
    expect(result.error).toContain('committed');
    expect(result.error).toContain('must be');
  });

  test('rejects rollback of already rolled-back sandbox', async () => {
    initRepo(repoDir, 'main');
    const session = await createGitSandbox('wf-014', repoDir);
    expect(session).not.toBeNull();
    const first = await rollbackGitSandbox(session!.id);
    expect(first.success).toBe(true);
    const second = await rollbackGitSandbox(session!.id);
    expect(second.success).toBe(false);
    expect(second.error).toContain('rolled_back');
  });

  test('returns error for nonexistent sandbox id', async () => {
    const result = await rollbackGitSandbox('does-not-exist');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Sandbox not found');
  });

  test('updates DB status to rolled_back on success', async () => {
    initRepo(repoDir, 'main');
    const session = await createGitSandbox('wf-015', repoDir);
    expect(session).not.toBeNull();
    await rollbackGitSandbox(session!.id);
    const db = getDb();
    const row = db.prepare('SELECT status FROM git_snapshots WHERE id = ?').get(session!.id) as { status: string };
    expect(row.status).toBe('rolled_back');
  });
});

describe('GitOperationError', () => {
  test('is exported and can be constructed with full metadata', () => {
    const err = new GitOperationError(['checkout', '-b', 'x'], 'branch already exists', 128);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(GitOperationError);
    expect(err.message).toContain('git checkout -b x failed');
    expect(err.message).toContain('branch already exists');
    expect(err.message).toContain('exit 128');
    expect(err.gitArgs).toEqual(['checkout', '-b', 'x']);
    expect(err.stderr).toBe('branch already exists');
    expect(err.exitCode).toBe(128);
  });

  test('handles missing exit code gracefully', () => {
    const err = new GitOperationError(['status'], 'something broke');
    expect(err.message).toContain('exit ?');
    expect(err.exitCode).toBeUndefined();
  });

  test('createGitSandbox returns null when critical git op fails', async () => {
    const bareDir = join(tempDir, 'bare');
    execSync('mkdir -p ' + bareDir);
    writeFileSync(join(bareDir, '.git'), 'invalid');
    const session = await createGitSandbox('wf-021', bareDir);
    expect(session).toBeNull();
  });
});

describe('base_branch migration backward compatibility', () => {
  test('rollback handles legacy row without base_branch via detached HEAD', async () => {
    initRepo(repoDir, 'develop');
    const session = await createGitSandbox('wf-030', repoDir);
    expect(session).not.toBeNull();
    const db = getDb();
    db.prepare('UPDATE git_snapshots SET base_branch = NULL WHERE id = ?').run(session!.id);
    const result = await rollbackGitSandbox(session!.id);
    expect(result.success).toBe(true);
    const head = gitSync(repoDir, 'rev-parse', 'HEAD');
    expect(head).toBe(session!.baseCommit);
  });
});

describe('commitGitSandbox reliability', () => {
  test('successful commit advances HEAD and returns post-commit SHA', async () => {
    initRepo(repoDir, 'main');
    const session = await createGitSandbox('wf-100', repoDir);
    expect(session).not.toBeNull();
    const preCommitHead = gitSync(repoDir, 'rev-parse', 'HEAD');
    writeFileSync(join(repoDir, 'new-file.txt'), 'content');
    const result = await commitGitSandbox(session!.id, 'test commit');
    expect(result.success).toBe(true);
    expect(result.commit).toBeDefined();
    expect(result.commit).not.toBe(preCommitHead);
    expect(result.filesChanged).toContain('new-file.txt');
    expect(result.error).toBeUndefined();
    // HEAD in the repo matches returned commit
    const actualHead = gitSync(repoDir, 'rev-parse', 'HEAD');
    expect(actualHead).toBe(result.commit);
  });

  test('commit with no changes succeeds and sets status to committed', async () => {
    initRepo(repoDir, 'main');
    const session = await createGitSandbox('wf-101', repoDir);
    expect(session).not.toBeNull();
    const result = await commitGitSandbox(session!.id);
    expect(result.success).toBe(true);
    expect(result.filesChanged).toEqual([]);
    const db = getDb();
    const row = db.prepare('SELECT status FROM git_snapshots WHERE id = ?').get(session!.id) as { status: string };
    expect(row.status).toBe('committed');
  });

  test('rejecting pre-commit hook causes commit failure and preserves active status', async () => {
    initRepo(repoDir, 'main');
    const session = await createGitSandbox('wf-102', repoDir);
    expect(session).not.toBeNull();

    // Install a pre-commit hook that rejects all commits
    const hooksDir = join(repoDir, '.git', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    const hookPath = join(hooksDir, 'pre-commit');
    writeFileSync(hookPath, '#!/bin/sh\necho "hook rejected" >&2\nexit 1\n');
    chmodSync(hookPath, 0o755);

    // Create a file so there's something to commit
    writeFileSync(join(repoDir, 'blocked-file.txt'), 'should not be committed');

    const result = await commitGitSandbox(session!.id, 'should fail');

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toBeTruthy();
    expect(result.commit).toBeUndefined();

    // Sandbox stays active — not incorrectly marked as committed
    const db = getDb();
    const row = db.prepare('SELECT status FROM git_snapshots WHERE id = ?').get(session!.id) as { status: string };
    expect(row.status).toBe('active');
  });

  test('commit failure does not advance HEAD', async () => {
    initRepo(repoDir, 'main');
    const session = await createGitSandbox('wf-103', repoDir);
    expect(session).not.toBeNull();
    const headBefore = gitSync(repoDir, 'rev-parse', 'HEAD');

    // Install rejecting hook
    const hooksDir = join(repoDir, '.git', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, 'pre-commit'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(hooksDir, 'pre-commit'), 0o755);

    writeFileSync(join(repoDir, 'file.txt'), 'data');
    await commitGitSandbox(session!.id, 'should fail');

    // HEAD must not have moved
    const headAfter = gitSync(repoDir, 'rev-parse', 'HEAD');
    expect(headAfter).toBe(headBefore);
  });

  test('failed commit sandbox can still be rolled back', async () => {
    initRepo(repoDir, 'main');
    const session = await createGitSandbox('wf-104', repoDir);
    expect(session).not.toBeNull();

    // Install rejecting hook
    const hooksDir = join(repoDir, '.git', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, 'pre-commit'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(hooksDir, 'pre-commit'), 0o755);

    writeFileSync(join(repoDir, 'file.txt'), 'data');
    const commitResult = await commitGitSandbox(session!.id, 'should fail');
    expect(commitResult.success).toBe(false);

    // Remove the hook so rollback's internal operations aren't blocked
    rmSync(join(hooksDir, 'pre-commit'));

    // Since status stayed 'active', rollback should work
    const rollbackResult = await rollbackGitSandbox(session!.id);
    expect(rollbackResult.success).toBe(true);

    const db = getDb();
    const row = db.prepare('SELECT status FROM git_snapshots WHERE id = ?').get(session!.id) as { status: string };
    expect(row.status).toBe('rolled_back');
  });

  test('returns error for nonexistent sandbox id', async () => {
    const result = await commitGitSandbox('nonexistent-id', 'msg');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Sandbox not found or not active');
  });

  test('returns error for already-committed sandbox', async () => {
    initRepo(repoDir, 'main');
    const session = await createGitSandbox('wf-105', repoDir);
    expect(session).not.toBeNull();
    writeFileSync(join(repoDir, 'file.txt'), 'data');
    const first = await commitGitSandbox(session!.id, 'first commit');
    expect(first.success).toBe(true);
    const second = await commitGitSandbox(session!.id, 'second commit');
    expect(second.success).toBe(false);
    expect(second.error).toBe('Sandbox not found or not active');
  });

  test('DB records files_changed only on confirmed commit', async () => {
    initRepo(repoDir, 'main');
    const session = await createGitSandbox('wf-106', repoDir);
    expect(session).not.toBeNull();
    writeFileSync(join(repoDir, 'a.txt'), 'aaa');
    writeFileSync(join(repoDir, 'b.txt'), 'bbb');
    const result = await commitGitSandbox(session!.id, 'multi-file commit');
    expect(result.success).toBe(true);
    expect(result.filesChanged).toContain('a.txt');
    expect(result.filesChanged).toContain('b.txt');
    const db = getDb();
    const row = db.prepare('SELECT files_changed FROM git_snapshots WHERE id = ?').get(session!.id) as {
      files_changed: string;
    };
    const recorded = JSON.parse(row.files_changed);
    expect(recorded).toContain('a.txt');
    expect(recorded).toContain('b.txt');
  });
});
