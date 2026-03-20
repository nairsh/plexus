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
import { getDb, getErrorMessage, logger } from '@orchestrator/shared';

const execFileAsync = promisify(execFile);

export interface GitSandboxSession {
  id: string;
  workflowId: string;
  taskId?: string;
  workspacePath: string;
  branchName: string;
  baseCommit: string;
  status: 'active' | 'committed' | 'rolled_back';
}

// ── Git helpers ───────────────────────────────────────────────────────────────

async function git(cwd: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', args, { cwd, timeout: 30_000 }).catch(
    (err: { stdout?: string; stderr?: string; message?: string }) => ({
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? err.message ?? '',
    })
  );
}

async function isGitRepo(path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  const { stdout } = await git(path, 'rev-parse', '--is-inside-work-tree');
  return stdout.trim() === 'true';
}

async function getCurrentCommit(path: string): Promise<string> {
  const { stdout } = await git(path, 'rev-parse', 'HEAD');
  return stdout.trim();
}

async function getCurrentBranch(path: string): Promise<string> {
  const { stdout } = await git(path, 'rev-parse', '--abbrev-ref', 'HEAD');
  return stdout.trim();
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
    logger.info({ workspacePath }, 'Workspace is not a git repo — skipping git sandbox');
    return null;
  }

  try {
    const baseCommit = await getCurrentCommit(workspacePath);
    const baseBranch = await getCurrentBranch(workspacePath);
    const sandboxId = crypto.randomUUID();
    const branchName = `agent/${workflowId.slice(0, 8)}/${sandboxId.slice(0, 8)}`;

    // Create a new branch for the agent's work
    await git(workspacePath, 'checkout', '-b', branchName);

    logger.info({ workflowId, branchName, baseCommit }, 'Git sandbox created');

    // Persist to DB
    const db = getDb();
    db.prepare(`
      INSERT INTO git_snapshots (id, workflow_id, task_id, workspace_path, branch_name, base_commit, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(sandboxId, workflowId, taskId ?? null, workspacePath, branchName, baseCommit);

    return {
      id: sandboxId,
      workflowId,
      taskId,
      workspacePath,
      branchName,
      baseCommit,
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
 */
export async function commitGitSandbox(
  sandboxId: string,
  commitMessage?: string
): Promise<{ success: boolean; commit?: string; filesChanged: string[] }> {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM git_snapshots WHERE id = ?')
    .get(sandboxId) as GitSandboxSession | undefined;

  if (!row || row.status !== 'active') {
    return { success: false, filesChanged: [] };
  }

  try {
    // Stage all changes
    await git(row.workspacePath, 'add', '-A');

    // Get list of changed files before committing
    const { stdout: diffOutput } = await git(
      row.workspacePath,
      'diff',
      '--cached',
      '--name-only'
    );
    const filesChanged = diffOutput.split('\n').filter(Boolean);

    if (filesChanged.length === 0) {
      logger.info({ sandboxId }, 'No changes to commit in git sandbox');
      db.prepare(
        "UPDATE git_snapshots SET status = 'committed', updated_at = datetime('now') WHERE id = ?"
      ).run(sandboxId);
      return { success: true, filesChanged: [] };
    }

    // Commit
    const message = commitMessage ?? `Agent work: ${new Date().toISOString()}`;
    await git(row.workspacePath, 'commit', '-m', message);

    const commit = await getCurrentCommit(row.workspacePath);

    // Update DB
    db.prepare(
      "UPDATE git_snapshots SET status = 'committed', files_changed = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(JSON.stringify(filesChanged), sandboxId);

    logger.info({ sandboxId, commit, filesChanged: filesChanged.length }, 'Git sandbox committed');
    return { success: true, commit, filesChanged };
  } catch (err) {
    logger.error({ sandboxId, error: getErrorMessage(err) }, 'Failed to commit git sandbox');
    return { success: false, filesChanged: [] };
  }
}

/**
 * Roll back all agent changes to the base commit.
 * Use this when the agent made bad changes the user wants to undo.
 */
export async function rollbackGitSandbox(
  sandboxId: string
): Promise<{ success: boolean; error?: string }> {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM git_snapshots WHERE id = ?')
    .get(sandboxId) as GitSandboxSession | undefined;

  if (!row) {
    return { success: false, error: 'Sandbox not found' };
  }

  try {
    // Get the branch we're on
    const currentBranch = await getCurrentBranch(row.workspacePath);

    // Discard all staged and unstaged changes
    await git(row.workspacePath, 'reset', '--hard', 'HEAD');
    await git(row.workspacePath, 'clean', '-fd');

    // If we're on the sandbox branch, switch back to the base branch
    if (currentBranch === row.branchName) {
      // Find what branch to switch back to — usually 'main' or 'master'
      const { stdout } = await git(row.workspacePath, 'branch', '-a');
      const mainBranch = stdout
        .split('\n')
        .map((b) => b.trim().replace(/^\* /, ''))
        .find((b) => b === 'main' || b === 'master') ?? 'HEAD';

      await git(row.workspacePath, 'checkout', mainBranch);
    }

    // Reset to base commit on the current branch
    await git(row.workspacePath, 'reset', '--hard', row.baseCommit);

    // Delete the sandbox branch
    await git(row.workspacePath, 'branch', '-D', row.branchName).catch(() => {
      // Ignore if branch deletion fails
    });

    // Update DB
    db.prepare(
      "UPDATE git_snapshots SET status = 'rolled_back', updated_at = datetime('now') WHERE id = ?"
    ).run(sandboxId);

    logger.info({ sandboxId, baseCommit: row.baseCommit }, 'Git sandbox rolled back');
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
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM git_snapshots WHERE id = ?')
    .get(sandboxId) as GitSandboxSession | undefined;

  if (!row) return { diff: '', filesChanged: [], lineCount: 0 };

  try {
    const { stdout: diff } = await git(
      row.workspacePath,
      'diff',
      row.baseCommit,
      'HEAD'
    );

    const { stdout: nameOnly } = await git(
      row.workspacePath,
      'diff',
      '--name-only',
      row.baseCommit,
      'HEAD'
    );

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
  return db
    .prepare('SELECT * FROM git_snapshots WHERE workflow_id = ? ORDER BY created_at DESC')
    .all(workflowId) as GitSandboxSession[];
}
