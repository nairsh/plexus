import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DEFAULT_CREDIT_BALANCE,
  encryptJson,
  getDb,
  getErrorMessage,
  logger,
  SandboxError,
} from '@orchestrator/shared';
import type { SandboxConfig, SandboxSession } from '@orchestrator/shared';
import { activateWorkspace, deactivateWorkspace, ensureWorkspace, getWorkspacePaths } from '../workspaces.js';
import { startOpenTerminal, stopOpenTerminal, writeOpenTerminalFile } from '../openTerminal.js';
import { installPackages } from './installPackages.js';
import { validatePath } from './pathSafety.js';
import { sessions, type SessionState } from './store.js';

export async function createSession(userId: string, config: SandboxConfig): Promise<SandboxSession> {
  const sessionId = crypto.randomUUID();
  const baseDir = join(tmpdir(), `sandbox-${sessionId}`);
  const requestedWorkingDirectory = config.working_directory?.trim();
  const workspaceDir = requestedWorkingDirectory
    ? realpathSync(resolve(requestedWorkingDirectory))
    : join(baseDir, 'workspace');
  const chatId = config.chat_id ?? null;
  const ephemeral = !requestedWorkingDirectory;

  try {
    mkdirSync(workspaceDir, { recursive: true });
  } catch (err) {
    throw new SandboxError(`Failed to create session directory: ${getErrorMessage(err)}`);
  }

  const state: SessionState = {
    id: sessionId,
    userId,
    chatId,
    language: config.language,
    workingDir: workspaceDir,
    ephemeral,
    status: 'creating',
    environmentStatus: chatId && !requestedWorkingDirectory ? 'starting' : 'running',
    config,
    createdAt: Date.now(),
    runningProcess: null,
    openTerminal: null,
  };

  sessions.set(sessionId, state);

  // Ensure user exists BEFORE creating workspace (foreign key constraint on sandbox_workspaces.user_id)
  const db = getDb();
  const userExists = db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId);
  if (!userExists) {
    db.prepare(
      "INSERT INTO users (id, email, tier, credits_balance, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
    ).run(userId, `${userId}@localhost`, 'pro', DEFAULT_CREDIT_BALANCE);
  }

  // Ensure workspace exists BEFORE inserting session (foreign key constraint)
  if (chatId && !requestedWorkingDirectory) {
    ensureWorkspace(userId, chatId, config.language);
  }

  // Persist to DB
  db.prepare(
    `INSERT INTO sandbox_sessions (id, task_id, user_id, chat_id, language, working_dir, environment_status, status, config)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    sessionId,
    config.task_id ?? null,
    userId,
    chatId,
    config.language,
    workspaceDir,
    state.environmentStatus,
    'creating',
    JSON.stringify(config)
  );

  try {
    if (chatId && !requestedWorkingDirectory) {
      activateWorkspace(userId, chatId, sessionId, config.language, workspaceDir);
      state.environmentStatus = 'running';

      try {
        const workspace = getWorkspacePaths(userId, chatId);
        const openTerminal = await startOpenTerminal(chatId, workspace.filesPath);
        state.openTerminal = openTerminal;
        db.prepare('UPDATE sandbox_sessions SET open_terminal_url = ?, open_terminal_api_key = ? WHERE id = ?').run(
          openTerminal.baseUrl,
          encryptJson(openTerminal.apiKey),
          sessionId
        );
      } catch (err) {
        logger.warn(
          { chatId, sessionId, error: getErrorMessage(err) },
          'Open Terminal unavailable, falling back to local workspace mode'
        );
      }
    }

    // Install packages if requested
    if (config.packages && config.packages.length > 0) {
      if (state.openTerminal) {
        throw new SandboxError(
          'Package installation is not supported for Open Terminal workspaces',
          'open_terminal_packages_unsupported'
        );
      }
      await installPackages(workspaceDir, config.language, config.packages);
    }

    // Write initial files
    if (config.files) {
      for (const file of config.files) {
        const filePath = validatePath(workspaceDir, file.path);
        const dir = join(filePath, '..');
        mkdirSync(dir, { recursive: true });
        const content = Buffer.from(file.content_base64, 'base64');
        writeFileSync(filePath, content);
        if (state.openTerminal) {
          await writeOpenTerminalFile(state.openTerminal, file.path, content);
        }
      }
    }

    state.status = 'ready';
    db.prepare('UPDATE sandbox_sessions SET status = ?, environment_status = ? WHERE id = ?').run(
      'ready',
      state.environmentStatus,
      sessionId
    );

    logger.info({ sessionId, language: config.language, userId }, 'Sandbox session created');

    return {
      id: sessionId,
      status: 'ready',
      language: config.language,
      chat_id: chatId ?? undefined,
      environment_status: state.environmentStatus,
      workspace_path: requestedWorkingDirectory
        ? workspaceDir
        : chatId
          ? getWorkspacePaths(userId, chatId).filesPath
          : workspaceDir,
      working_directory: requestedWorkingDirectory ? workspaceDir : undefined,
      created_at: new Date(state.createdAt).toISOString(),
    };
  } catch (err) {
    state.status = 'error';
    db.prepare('UPDATE sandbox_sessions SET status = ? WHERE id = ?').run('error', sessionId);
    throw new SandboxError(`Failed to initialize session: ${getErrorMessage(err)}`);
  }
}

export function terminateSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return; // Already gone
  const usedOpenTerminal = Boolean(session.openTerminal);

  if (session.runningProcess) {
    try {
      session.runningProcess.kill('SIGKILL');
    } catch {
      // Process may already be dead
    }
    session.runningProcess = null;
  }

  if (session.openTerminal) {
    deactivateWorkspace(sessionId, session.workingDir, false);
    stopOpenTerminal(session.openTerminal);
    session.openTerminal = null;
  }

  try {
    if (session.chatId && !usedOpenTerminal && session.ephemeral) {
      deactivateWorkspace(sessionId, session.workingDir);
    }

    if (session.ephemeral) {
      const tempBaseDir = join(session.workingDir, '..');
      rmSync(tempBaseDir, { recursive: true, force: true });
    }
  } catch (err) {
    logger.warn({ sessionId, error: getErrorMessage(err) }, 'Failed to clean up sandbox directory');
  }

  session.status = 'terminated';

  const db = getDb();
  db.prepare("UPDATE sandbox_sessions SET status = 'terminated', terminated_at = datetime('now') WHERE id = ?").run(
    sessionId
  );

  sessions.delete(sessionId);

  logger.info({ sessionId }, 'Sandbox session terminated');
}

export function getSessionInfo(sessionId: string): SandboxSession | null {
  const session = sessions.get(sessionId);
  if (!session) {
    const db = getDb();
    const row = db
      .prepare(
        'SELECT id, status, language, chat_id, working_dir, environment_status, created_at FROM sandbox_sessions WHERE id = ?'
      )
      .get(sessionId) as
      | {
          id: string;
          status: string;
          language: string;
          chat_id?: string;
          working_dir?: string;
          environment_status?: string;
          created_at: string;
        }
      | undefined;

    if (!row) return null;
    return {
      id: row.id,
      status: row.status as SandboxSession['status'],
      language: row.language,
      chat_id: row.chat_id,
      environment_status: (row.environment_status as SandboxSession['environment_status']) ?? 'stopped',
      workspace_path: row.working_dir,
      working_directory: row.working_dir,
      created_at: row.created_at,
    };
  }

  return {
    id: session.id,
    status: session.status,
    language: session.language,
    chat_id: session.chatId ?? undefined,
    environment_status: session.environmentStatus,
    workspace_path: session.workingDir,
    working_directory: session.config.working_directory,
    created_at: new Date(session.createdAt).toISOString(),
  };
}
