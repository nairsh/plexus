import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDb, getEnv, SandboxError } from '@orchestrator/shared';
import type { ExecutionResult } from '@orchestrator/shared';
import { executeInOpenTerminal } from '../openTerminal.js';
import { listFilesRecursive } from './fileListing.js';
import { getSessionOrThrow } from './store.js';

export async function execute(sessionId: string, code: string, timeoutSeconds?: number): Promise<ExecutionResult> {
  const session = getSessionOrThrow(sessionId);
  if (session.status === 'executing') {
    throw new SandboxError('Session is already executing code', 'session_busy');
  }

  const env = getEnv();
  const timeout = Math.min(timeoutSeconds ?? env.SANDBOX_DEFAULT_TIMEOUT, env.SANDBOX_MAX_TIMEOUT);
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

  let command: string;
  let args: string[];
  let stdinData: string | null = null;

  switch (session.language) {
    case 'python': {
      const scriptFile = join(session.workingDir, '_script.py');
      writeFileSync(scriptFile, code, 'utf-8');
      command = 'python3';
      args = ['_script.py'];
      break;
    }
    case 'javascript': {
      const scriptFile = join(session.workingDir, '_script.js');
      writeFileSync(scriptFile, code, 'utf-8');
      command = 'node';
      args = ['_script.js'];
      break;
    }
    case 'sql': {
      command = 'sqlite3';
      args = [':memory:'];
      stdinData = code;
      break;
    }
    default:
      throw new SandboxError(`Unsupported language: ${session.language}`);
  }

  const startTime = process.hrtime.bigint();

  return new Promise<ExecutionResult>((resolvePromise) => {
    // Explicit env allowlist — do not pass host secrets (API keys, DATABASE_PATH, etc.)
    const childEnv: Record<string, string> = {
      PATH: env.PATH,
      HOME: env.HOME,
      LANG: env.LANG,
      TERM: env.TERM,
      NODE_ENV: env.NODE_ENV,
    };

    // For Python, set PYTHONPATH to .packages dir
    if (session.language === 'python') {
      const packagesDir = join(session.workingDir, '.packages');
      if (existsSync(packagesDir)) {
        childEnv['PYTHONPATH'] = packagesDir;
      }
    }

    const child = spawn(command, args, {
      cwd: session.workingDir,
      env: childEnv,
      stdio: stdinData ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    });

    session.runningProcess = child;

    if (stdinData) {
      child.stdin!.write(stdinData);
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

    let timedOut = false;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // Ignore kill failures
      }
    }, timeoutMs);
    (timeoutTimer as unknown as { unref?: () => void }).unref?.();

    const finish = (exitCode: number | null, extraError?: string) => {
      clearTimeout(timeoutTimer);
      const endTime = process.hrtime.bigint();
      const executionTimeMs = Number(endTime - startTime) / 1_000_000;

      session.runningProcess = null;
      session.status = 'ready';
      db.prepare('UPDATE sandbox_sessions SET status = ? WHERE id = ?').run('ready', sessionId);

      const filesAfter = listFilesRecursive(session.workingDir);
      const filesModified = filesAfter.filter((f) => !f.startsWith('_script.') && !filesBefore.includes(f));

      resolvePromise({
        stdout,
        stderr: [stderr, timedOut ? `Timed out after ${timeout}s` : null, extraError ?? null]
          .filter((part): part is string => Boolean(part && part.trim().length > 0))
          .join('\n'),
        exit_code: timedOut ? 124 : (exitCode ?? 1),
        execution_time_ms: Math.round(executionTimeMs),
        files_modified: filesModified,
      });
    };

    child.on('close', (exitCode) => finish(exitCode));
    child.on('error', (err) => finish(1, `Process error: ${err.message}`));
  });
}
