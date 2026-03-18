import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, normalize } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_CREDIT_BALANCE, getDb, getErrorMessage, logger, SandboxError } from '@orchestrator/shared';
import type { SandboxConfig, SandboxSession, ExecutionResult } from '@orchestrator/shared';
import { debitCredits } from '@orchestrator/billing';
import { activateWorkspace, deactivateWorkspace, ensureWorkspace, getWorkspaceInfo, getWorkspacePaths } from './workspaces.js';
import {
  executeInOpenTerminal,
  listOpenTerminalFiles,
  readOpenTerminalFile,
  startOpenTerminal,
  stopOpenTerminal,
  writeOpenTerminalFile,
  type OpenTerminalSession,
} from './openTerminal.js';

interface SessionState {
  id: string;
  userId: string;
  chatId: string | null;
  language: string;
  workingDir: string;
  status: 'creating' | 'ready' | 'executing' | 'terminated' | 'error';
  environmentStatus: 'stopped' | 'starting' | 'running';
  config: SandboxConfig;
  createdAt: number;
  runningProcess: ChildProcess | null;
  openTerminal: OpenTerminalSession | null;
}

const sessions = new Map<string, SessionState>();

// ── Path safety ──

function validatePath(sessionDir: string, requestedPath: string): string {
  const normalized = normalize(requestedPath);
  if (normalized.includes('..') || normalized.startsWith('/')) {
    throw new SandboxError('Path traversal detected: paths must be relative and cannot contain ".."', 'path_traversal');
  }
  const full = resolve(sessionDir, normalized);
  if (!full.startsWith(sessionDir)) {
    throw new SandboxError('Path traversal detected: resolved path is outside workspace', 'path_traversal');
  }
  return full;
}

function getSession(sessionId: string): SessionState {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new SandboxError(`Session not found: ${sessionId}`, 'session_not_found');
  }
  if (session.status === 'terminated') {
    throw new SandboxError(`Session has been terminated: ${sessionId}`, 'session_terminated');
  }
  return session;
}

// ── SandboxManager ──

export async function createSession(
  userId: string,
  config: SandboxConfig
): Promise<SandboxSession> {
  const sessionId = crypto.randomUUID();
  const baseDir = join(tmpdir(), `sandbox-${sessionId}`);
  const workspaceDir = join(baseDir, 'workspace');
  const chatId = config.chat_id ?? null;

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
    status: 'creating',
    environmentStatus: chatId ? 'starting' : 'running',
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
  if (chatId) {
    ensureWorkspace(userId, chatId, config.language);
  }

  // Persist to DB
  db.prepare(
    `INSERT INTO sandbox_sessions (id, task_id, user_id, chat_id, language, working_dir, environment_status, status, config)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(sessionId, config.task_id ?? null, userId, chatId, config.language, workspaceDir, state.environmentStatus, 'creating', JSON.stringify(config));

  try {
    if (chatId) {
      activateWorkspace(userId, chatId, sessionId, config.language, workspaceDir);
      state.environmentStatus = 'running';

      try {
        const workspace = getWorkspacePaths(chatId);
        const openTerminal = await startOpenTerminal(chatId, workspace.filesPath);
        state.openTerminal = openTerminal;
        db.prepare('UPDATE sandbox_sessions SET open_terminal_url = ? WHERE id = ?').run(openTerminal.baseUrl, sessionId);
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
        throw new SandboxError('Package installation is not supported for Open Terminal workspaces', 'open_terminal_packages_unsupported');
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
    db.prepare('UPDATE sandbox_sessions SET status = ?, environment_status = ? WHERE id = ?').run('ready', state.environmentStatus, sessionId);

    logger.info({ sessionId, language: config.language, userId }, 'Sandbox session created');

    return {
      id: sessionId,
      status: 'ready',
      language: config.language,
      chat_id: chatId ?? undefined,
      environment_status: state.environmentStatus,
      workspace_path: chatId ? getWorkspaceInfo(chatId)?.['workspace_path'] as string | undefined : workspaceDir,
      created_at: new Date(state.createdAt).toISOString(),
    };
  } catch (err) {
    state.status = 'error';
    db.prepare('UPDATE sandbox_sessions SET status = ? WHERE id = ?').run('error', sessionId);
    throw new SandboxError(`Failed to initialize session: ${getErrorMessage(err)}`);
  }
}

async function installPackages(
  workspaceDir: string,
  language: string,
  packages: string[]
): Promise<void> {
  const sanitized = packages.map((p) => p.replace(/[;&|`$(){}]/g, ''));
  const timeout = 60_000; // 60s for package installation

  if (language === 'python') {
    const packagesDir = join(workspaceDir, '.packages');
    mkdirSync(packagesDir, { recursive: true });
    try {
      execSync(`python3 -m pip install --target "${packagesDir}" ${sanitized.join(' ')}`, {
        cwd: workspaceDir,
        timeout,
        stdio: 'pipe',
      });
    } catch (err) {
      throw new SandboxError(`Failed to install Python packages: ${getErrorMessage(err)}`);
    }
  } else if (language === 'javascript') {
    // Initialize package.json if needed
    if (!existsSync(join(workspaceDir, 'package.json'))) {
      writeFileSync(join(workspaceDir, 'package.json'), JSON.stringify({ name: 'sandbox', version: '1.0.0', type: 'module' }));
    }
    try {
      execSync(`npm install --prefix "${workspaceDir}" ${sanitized.join(' ')}`, {
        cwd: workspaceDir,
        timeout,
        stdio: 'pipe',
      });
    } catch (err) {
      throw new SandboxError(`Failed to install Node packages: ${getErrorMessage(err)}`);
    }
  }
}

export async function execute(
  sessionId: string,
  code: string,
  timeoutSeconds?: number
): Promise<ExecutionResult> {
  const session = getSession(sessionId);
  if (session.status === 'executing') {
    throw new SandboxError('Session is already executing code', 'session_busy');
  }

  const maxTimeout = parseInt(process.env['SANDBOX_MAX_TIMEOUT'] || '3600', 10);
  const defaultTimeout = parseInt(process.env['SANDBOX_DEFAULT_TIMEOUT'] || '300', 10);
  const timeout = Math.min(timeoutSeconds ?? defaultTimeout, maxTimeout);
  const timeoutMs = timeout * 1000;

  session.status = 'executing';
  const db = getDb();
  db.prepare('UPDATE sandbox_sessions SET status = ? WHERE id = ?').run('executing', sessionId);

  if (session.openTerminal) {
    const result = await executeInOpenTerminal(session.openTerminal, session.language, code, timeout);
    session.status = 'ready';
    db.prepare('UPDATE sandbox_sessions SET status = ? WHERE id = ?').run('ready', sessionId);
    return result;
  }

  // Snapshot filesystem before execution
  const filesBefore = listFilesRecursive(session.workingDir);

  let scriptFile: string;
  let command: string;
  let args: string[];

  switch (session.language) {
    case 'python': {
      scriptFile = join(session.workingDir, '_script.py');
      writeFileSync(scriptFile, code, 'utf-8');
      command = 'python3';
      args = ['_script.py'];
      break;
    }
    case 'javascript': {
      scriptFile = join(session.workingDir, '_script.js');
      writeFileSync(scriptFile, code, 'utf-8');
      command = 'node';
      args = ['_script.js'];
      break;
    }
    case 'sql': {
      scriptFile = join(session.workingDir, '_script.sql');
      writeFileSync(scriptFile, code, 'utf-8');
      command = 'sqlite3';
      args = [':memory:'];
      break;
    }
    default:
      throw new SandboxError(`Unsupported language: ${session.language}`);
  }

  const startTime = process.hrtime.bigint();

  return new Promise<ExecutionResult>((resolvePromise) => {
    const env: Record<string, string> = { ...process.env as Record<string, string> };

    // For Python, set PYTHONPATH to .packages dir
    if (session.language === 'python') {
      const packagesDir = join(session.workingDir, '.packages');
      if (existsSync(packagesDir)) {
        env['PYTHONPATH'] = packagesDir + (env['PYTHONPATH'] ? `:${env['PYTHONPATH']}` : '');
      }
    }

    const child = spawn(command, args, {
      cwd: session.workingDir,
      timeout: timeoutMs,
      env,
      stdio: session.language === 'sql' ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    });

    session.runningProcess = child;

    // For SQL, pipe the script to stdin
    if (session.language === 'sql') {
      child.stdin!.write(code);
      child.stdin!.end();
    }

    let stdout = '';
    let stderr = '';

    child.stdout!.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr!.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('close', (exitCode) => {
      const endTime = process.hrtime.bigint();
      const executionTimeMs = Number(endTime - startTime) / 1_000_000;

      session.runningProcess = null;
      session.status = 'ready';
      db.prepare('UPDATE sandbox_sessions SET status = ? WHERE id = ?').run('ready', sessionId);

      // Detect modified files
      const filesAfter = listFilesRecursive(session.workingDir);
      const filesModified = filesAfter.filter(
        (f) => !f.startsWith('_script.') && !filesBefore.includes(f)
      );

      resolvePromise({
        stdout,
        stderr,
        exit_code: exitCode ?? 1,
        execution_time_ms: Math.round(executionTimeMs),
        files_modified: filesModified,
      });
    });

    child.on('error', (err) => {
      const endTime = process.hrtime.bigint();
      const executionTimeMs = Number(endTime - startTime) / 1_000_000;

      session.runningProcess = null;
      session.status = 'ready';
      db.prepare('UPDATE sandbox_sessions SET status = ? WHERE id = ?').run('ready', sessionId);

      resolvePromise({
        stdout,
        stderr: stderr + `\nProcess error: ${err.message}`,
        exit_code: 1,
        execution_time_ms: Math.round(executionTimeMs),
        files_modified: [],
      });
    });
  });
}

function listFilesRecursive(dir: string, prefix = ''): string[] {
  const results: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.packages') continue;
        results.push(...listFilesRecursive(join(dir, entry.name), rel));
      } else {
        results.push(rel);
      }
    }
  } catch {
    // Directory may not exist
  }
  return results;
}

export async function readSandboxFile(sessionId: string, filePath: string): Promise<Buffer> {
  const session = getSession(sessionId);

  if (session.openTerminal) {
    return readOpenTerminalFile(session.openTerminal, filePath);
  }

  const fullPath = validatePath(session.workingDir, filePath);

  try {
    return readFileSync(fullPath);
  } catch {
    throw new SandboxError(`File not found: ${filePath}`, 'file_not_found');
  }
}

export async function writeSandboxFile(
  sessionId: string,
  filePath: string,
  content: Buffer
): Promise<void> {
  const session = getSession(sessionId);

  if (session.openTerminal) {
    await writeOpenTerminalFile(session.openTerminal, filePath, content);
    return;
  }

  const fullPath = validatePath(session.workingDir, filePath);
  const dir = join(fullPath, '..');
  mkdirSync(dir, { recursive: true });
  writeFileSync(fullPath, content);
}

export async function listSandboxFiles(
  sessionId: string,
  directory?: string
): Promise<string[]> {
  const session = getSession(sessionId);

  if (session.openTerminal) {
    return listOpenTerminalFiles(session.openTerminal, directory);
  }

  const targetDir = directory
    ? validatePath(session.workingDir, directory)
    : session.workingDir;

  return listFilesRecursive(targetDir);
}

export function terminateSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return; // Already gone
  const usedOpenTerminal = Boolean(session.openTerminal);

  // Kill running process
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

  // Remove temp directory
  try {
    if (session.chatId && !usedOpenTerminal) {
      deactivateWorkspace(sessionId, session.workingDir);
    }

    // Go up one level from workspace to the sandbox-{uuid} dir
    const baseDir = join(session.workingDir, '..');
    rmSync(baseDir, { recursive: true, force: true });
  } catch (err) {
    logger.warn({ sessionId, error: getErrorMessage(err) }, 'Failed to clean up sandbox directory');
  }

  session.status = 'terminated';

  // Update DB
  const db = getDb();
  db.prepare(
    "UPDATE sandbox_sessions SET status = 'terminated', terminated_at = datetime('now') WHERE id = ?"
  ).run(sessionId);

  sessions.delete(sessionId);

  logger.info({ sessionId }, 'Sandbox session terminated');
}

export function getSessionInfo(sessionId: string): SandboxSession | null {
  const session = sessions.get(sessionId);
  if (!session) {
    // Check DB for terminated sessions
    const db = getDb();
    const row = db
      .prepare('SELECT id, status, language, chat_id, working_dir, environment_status, created_at FROM sandbox_sessions WHERE id = ?')
      .get(sessionId) as { id: string; status: string; language: string; chat_id?: string; working_dir?: string; environment_status?: string; created_at: string } | undefined;

    if (!row) return null;
    return {
      id: row.id,
      status: row.status as SandboxSession['status'],
      language: row.language,
      chat_id: row.chat_id,
      environment_status: (row.environment_status as SandboxSession['environment_status']) ?? 'stopped',
      workspace_path: row.working_dir,
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
    created_at: new Date(session.createdAt).toISOString(),
  };
}

// ── Session Reaper ──

export function startSessionReaper(): NodeJS.Timeout {
  const REAPER_INTERVAL = 5 * 60 * 1000; // 5 minutes
  const MAX_SESSION_AGE = parseInt(process.env['SANDBOX_MAX_TIMEOUT'] || '3600', 10) * 1000;

  return setInterval(() => {
    const now = Date.now();
    let reaped = 0;

    for (const [sessionId, session] of sessions) {
      if (session.status === 'terminated') continue;
      if (now - session.createdAt > MAX_SESSION_AGE) {
        logger.info({ sessionId, ageMs: now - session.createdAt }, 'Reaping expired sandbox session');
        terminateSession(sessionId);
        reaped++;
      }
    }

    if (reaped > 0) {
      logger.info({ reaped }, 'Session reaper completed');
    }
  }, REAPER_INTERVAL);
}

// ── Credit metering (1 credit per minute of active time) ──

export function startCreditMeter(): NodeJS.Timeout {
  const METER_INTERVAL = 60_000; // 1 minute

  return setInterval(() => {
    for (const [, session] of sessions) {
      if (session.status === 'terminated') continue;
      // Session is alive — debit 1 credit per minute
      try {
        debitCredits(
          session.userId,
          1.0,
          `Sandbox session ${session.id} (${session.language})`,
          'sandbox',
          session.id
        );
      } catch (err) {
        logger.warn(
          { sessionId: session.id, error: getErrorMessage(err) },
          'Failed to meter sandbox credits, terminating session'
        );
        terminateSession(session.id);
      }
    }
  }, METER_INTERVAL);
}

// ── Get active session count (for health checks) ──

export function getActiveSessionCount(): number {
  let count = 0;
  for (const [, session] of sessions) {
    if (session.status !== 'terminated') count++;
  }
  return count;
}
