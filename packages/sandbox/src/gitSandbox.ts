/**
 * Git-based workspace sandboxing for coding agents.
 *
 * Inspired by Vercel's just-bash OverlayFs pattern, this uses git to provide:
 * - Snapshot before agent starts (git stash or branch)
 * - Rollback if the agent makes bad changes (git checkout / reset)
 * - Diff visibility (what the agent changed)
 *
 * This is the recommended approach for the coding agent when working on real
 * user projects, as it gives users a safety net.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { getDb, getErrorMessage, logger, SandboxError } from '@orchestrator/shared';

const execFileAsync = promisify(execFile);

export interface GitSandboxSession {
  id: string;
  workflowId: string;
  taskId?: string;
  workspacePath: string;
  branchName: string;
  baseCommit: string;
  baseBranch?: string;
  status: 'active' | 'committed' | 'rolled_back';
}

/** Error thrown when a critical git operation fails. */
export class GitOperationError extends SandboxError {
  constructor(
    public readonly gitArgs: string[],
    public readonly stderr: string,
    public readonly exitCode?: number
  ) {
    super(
      `git ${gitArgs.join(' ')} failed (exit ${exitCode ?? '?'}): ${stderr.trim() || '(no output)'}`,
      'git_operation_failed'
    );
  }
}

// ── Internal DB row type (snake_case columns from SQLite) ─────────────────────

/** Raw row shape returned by better-sqlite3 (snake_case column names). */
interface GitSnapshotRow {
  id: string;
  workflow_id: string;
  task_id: string | null;
  workspace_path: string;
  branch_name: string;
  base_commit: string;
  base_branch: string | null;
  status: 'active' | 'committed' | 'rolled_back';
  files_changed: string;
  created_at: string;
  updated_at: string;
}

/** Map a raw DB row to the public GitSandboxSession shape. */
function rowToSession(row: GitSnapshotRow): GitSandboxSession {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    taskId: row.task_id ?? undefined,
    workspacePath: row.workspace_path,
    branchName: row.branch_name,
    baseCommit: row.base_commit,
    baseBranch: row.base_branch ?? undefined,
    status: row.status,
  };
}

// ── Git helpers ───────────────────────────────────────────────────────────────

/**
 * Run a git command, swallowing failures by returning empty stdout/stderr.
 * Use only for non-critical / best-effort operations (e.g. branch listing, diff).
 */
async function git(cwd: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', args, { cwd, timeout: 30_000 }).catch(
    (err: { stdout?: string; stderr?: string; message?: string }) => ({
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? err.message ?? '',
    })
  );
}

/**
 * Run a git command and throw GitOperationError on non-zero exit.
 * Use for critical operations where silent failure would corrupt state
 * (rev-parse, checkout -b, commit, rollback branch switching).
 */
async function gitStrict(cwd: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync('git', args, { cwd, timeout: 30_000 });
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string; code?: number };
    throw new GitOperationError(args, e.stderr ?? e.message ?? '', typeof e.code === 'number' ? e.code : undefined);
  }
}

async function isGitRepo(path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  const { stdout } = await git(path, 'rev-parse', '--is-inside-work-tree');
  return stdout.trim() === 'true';
}

async function getCurrentCommit(path: string): Promise<string> {
  const { stdout } = await gitStrict(path, 'rev-parse', 'HEAD');
  return stdout.trim();
}

async function getCurrentBranch(path: string): Promise<string> {
  const { stdout } = await gitStrict(path, 'rev-parse', '--abbrev-ref', 'HEAD');
  return stdout.trim();
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Load a git snapshot row from the DB and map it to the public interface. */
function loadSnapshot(sandboxId: string): GitSandboxSession | undefined {
  const db = getDb();
  const raw = db.prepare('SELECT * FROM git_snapshots WHERE id = ?').get(sandboxId) as GitSnapshotRow | undefined;
  return raw ? rowToSession(raw) : undefined;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Create a git sandbox for a coding agent.
 * Creates a new branch from the current HEAD so the agent can work safely.
 */
export async function createGitSandbox(
  workflowId: string,
  workspacePath: string,
  taskId?: string
): Promise<GitSandboxSession | null> {
  if (!(await isGitRepo(workspacePath))) {
    logger.info({ workspacePath }, 'Workspace is not a git repo \u2014 skipping git sandbox');
    return null;
  }

  try {
    const baseCommit = await getCurrentCommit(workspacePath);
    const baseBranch = await getCurrentBranch(workspacePath);
    const sandboxId = crypto.randomUUID();
    const branchName = `agent/${workflowId.slice(0, 8)}/${sandboxId.slice(0, 8)}`;

    // Create a new branch for the agent's work (strict \u2014 must succeed)
    await gitStrict(workspacePath, 'checkout', '-b', branchName);

    logger.info({ workflowId, branchName, baseCommit, baseBranch }, 'Git sandbox created');

    // Persist to DB (including baseBranch for safe rollback)
    const db = getDb();
    db.prepare(
      `
      INSERT INTO git_snapshots (id, workflow_id, task_id, workspace_path, branch_name, base_commit, base_branch, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
    `
    ).run(sandboxId, workflowId, taskId ?? null, workspacePath, branchName, baseCommit, baseBranch);

    return {
      id: sandboxId,
      workflowId,
      taskId,
      workspacePath,
      branchName,
      baseCommit,
      baseBranch,
      status: 'active',
    };
  } catch (err) {
    logger.warn({ workflowId, error: getErrorMessage(err) }, 'Failed to create git sandbox');
    return null;
  }
}

/**
 * Commit the agent's work to the sandbox branch.
 * Call this when the agent successfully completes its task.
 *
 * Reliability guarantees:
 * - `git add` and `git commit` use strict execution (throw on failure).
 * - After commit, HEAD is verified to have advanced from the pre-commit value.
 * - On any failure (staging, hook rejection, HEAD stale), the snapshot remains
 *   in 'active' status and the return value carries an explicit `error` string.
 */
export async function commitGitSandbox(
  sandboxId: string,
  commitMessage?: string
): Promise<{ success: boolean; commit?: string; filesChanged: string[]; error?: string }> {
  const row = loadSnapshot(sandboxId);

  if (!row || row.status !== 'active') {
    return { success: false, filesChanged: [], error: 'Sandbox not found or not active' };
  }

  try {
    // Stage all changes (strict — staging failure is a hard error)
    await gitStrict(row.workspacePath, 'add', '-A');

    // Get list of changed files before committing
    const { stdout: diffOutput } = await gitStrict(row.workspacePath, 'diff', '--cached', '--name-only');
    const filesChanged = diffOutput.split('\n').filter(Boolean);

    if (filesChanged.length === 0) {
      logger.info({ sandboxId }, 'No changes to commit in git sandbox');
      const db = getDb();
      db.prepare("UPDATE git_snapshots SET status = 'committed', updated_at = datetime('now') WHERE id = ?").run(
        sandboxId
      );
      return { success: true, filesChanged: [] };
    }

    // Capture pre-commit HEAD so we can verify advancement
    const preCommitHead = await getCurrentCommit(row.workspacePath);

    // Commit (strict — hook rejection or repo error is a hard failure)
    const message = commitMessage ?? `Agent work: ${new Date().toISOString()}`;
    await gitStrict(row.workspacePath, 'commit', '-m', message);

    // Verify HEAD actually advanced
    const postCommitHead = await getCurrentCommit(row.workspacePath);
    if (postCommitHead === preCommitHead) {
      const error = 'git commit returned success but HEAD did not advance';
      logger.error({ sandboxId, head: postCommitHead }, error);
      return { success: false, filesChanged: [], error };
    }

    // Only now update DB — commit is confirmed
    const db = getDb();
    db.prepare(
      "UPDATE git_snapshots SET status = 'committed', files_changed = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(JSON.stringify(filesChanged), sandboxId);

    logger.info({ sandboxId, commit: postCommitHead, filesChanged: filesChanged.length }, 'Git sandbox committed');
    return { success: true, commit: postCommitHead, filesChanged };
  } catch (err) {
    const error = getErrorMessage(err);
    logger.error({ sandboxId, error }, 'Failed to commit git sandbox');
    return { success: false, filesChanged: [], error };
  }
}

/**
 * Roll back all agent changes to the base commit.
 * Use this when the agent made bad changes the user wants to undo.
 *
 * Safety guarantees:
 * - Only active sandboxes can be rolled back.
 * - Restores checkout to the recorded original branch (baseBranch),
 *   never guesses main/master.
 * - Only resets the sandbox branch; never hard-resets the user's branch.
 */
export async function rollbackGitSandbox(sandboxId: string): Promise<{ success: boolean; error?: string }> {
  const row = loadSnapshot(sandboxId);

  if (!row) {
    return { success: false, error: 'Sandbox not found' };
  }

  if (row.status !== 'active') {
    return {
      success: false,
      error: `Cannot roll back sandbox with status '${row.status}' (must be 'active')`,
    };
  }

  try {
    // Discard all staged and unstaged changes on the sandbox branch
    await gitStrict(row.workspacePath, 'reset', '--hard', 'HEAD');
    await git(row.workspacePath, 'clean', '-fd');

    // Determine the original branch to restore.
    // Prefer the persisted baseBranch; legacy rows without it get the fallback.
    const targetBranch = row.baseBranch;

    const currentBranch = await getCurrentBranch(row.workspacePath);

    if (currentBranch === row.branchName) {
      if (targetBranch) {
        // Switch back to the user's original branch (strict \u2014 must succeed)
        await gitStrict(row.workspacePath, 'checkout', targetBranch);
      } else {
        // Legacy fallback: detach HEAD at baseCommit so we leave the user on
        // a known-good commit without touching any named branch.
        logger.warn({ sandboxId }, 'No base_branch recorded (legacy sandbox); detaching HEAD at baseCommit');
        await gitStrict(row.workspacePath, 'checkout', '--detach', row.baseCommit);
      }
    }

    // Delete the sandbox branch (best-effort; may already be gone)
    await git(row.workspacePath, 'branch', '-D', row.branchName);

    // Update DB
    const db = getDb();
    db.prepare("UPDATE git_snapshots SET status = 'rolled_back', updated_at = datetime('now') WHERE id = ?").run(
      sandboxId
    );

    logger.info(
      { sandboxId, baseCommit: row.baseCommit, restoredBranch: targetBranch ?? '(detached)' },
      'Git sandbox rolled back'
    );
    return { success: true };
  } catch (err) {
    const error = getErrorMessage(err);
    logger.error({ sandboxId, error }, 'Failed to rollback git sandbox');
    return { success: false, error };
  }
}

/**
 * Get a diff of all changes made by the agent in this sandbox.
 */
export async function getGitSandboxDiff(
  sandboxId: string
): Promise<{ diff: string; filesChanged: string[]; lineCount: number }> {
  const row = loadSnapshot(sandboxId);

  if (!row) return { diff: '', filesChanged: [], lineCount: 0 };

  try {
    const { stdout: diff } = await git(row.workspacePath, 'diff', row.baseCommit, 'HEAD');

    const { stdout: nameOnly } = await git(row.workspacePath, 'diff', '--name-only', row.baseCommit, 'HEAD');

    const filesChanged = nameOnly.split('\n').filter(Boolean);
    const lineCount = diff.split('\n').filter((l) => l.startsWith('+') || l.startsWith('-')).length;

    return { diff, filesChanged, lineCount };
  } catch (err) {
    logger.warn({ sandboxId, error: getErrorMessage(err) }, 'Failed to get git sandbox diff');
    return { diff: '', filesChanged: [], lineCount: 0 };
  }
}

/**
 * List all sandbox sessions for a workflow.
 */
export function listGitSandboxes(workflowId: string): GitSandboxSession[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM git_snapshots WHERE workflow_id = ? ORDER BY created_at DESC')
    .all(workflowId) as GitSnapshotRow[];
  return rows.map(rowToSession);
}
