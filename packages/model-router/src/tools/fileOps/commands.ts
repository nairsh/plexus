import { execFile } from 'node:child_process';
import { openTerminalFetchJson, SandboxError, getErrorMessage, logger } from '@orchestrator/shared';
import {
  globToRegExp,
  isLocalWorkspace,
  listLocalFilesRecursive,
  resolveWorkspacePath,
  shouldIgnorePath,
} from './paths.js';
import type { BashResult, GlobResult, GrepResult, WorkspaceSession } from './types.js';

const execFileAsync = (command: string, args: string[], options: { cwd: string; timeout: number }) => {
  return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolvePromise) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      const exitCode =
        error && typeof (error as { code?: number }).code === 'number'
          ? ((error as { code?: number }).code ?? 1)
          : error
            ? 1
            : 0;
      resolvePromise({ stdout: stdout ?? '', stderr: stderr ?? '', exitCode });
    });
  });
};

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`;

export async function executeBash(
  session: WorkspaceSession,
  command: string,
  timeoutSeconds: number = 60,
  signal?: AbortSignal
): Promise<BashResult> {
  try {
    if (isLocalWorkspace(session)) {
      const result = await new Promise<BashResult>((resolvePromise) => {
        const child = execFile(
          'bash',
          ['-lc', command],
          {
            cwd: session.workspacePath,
            timeout: Math.max(1, timeoutSeconds) * 1000,
          },
          (error, stdout, stderr) => {
            resolvePromise({
              stdout: stdout ?? '',
              stderr: stderr ?? '',
              exit_code:
                error && typeof (error as { code?: number }).code === 'number'
                  ? ((error as { code?: number }).code ?? 1)
                  : error
                    ? 1
                    : 0,
              command,
              interrupted: signal?.aborted === true,
            });
          }
        );

        if (signal) {
          const abortHandler = () => child.kill('SIGTERM');
          if (signal.aborted) {
            abortHandler();
          } else {
            signal.addEventListener('abort', abortHandler, { once: true });
          }
        }
      });

      return result;
    }

    const response = await openTerminalFetchJson<{
      status: string;
      exit_code: number | null;
      output: Array<{ type: string; data: string }>;
    }>(
      session,
      `/execute?wait=${Math.max(1, timeoutSeconds)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command }),
        signal,
      },
      Math.max(30_000, (Math.max(1, timeoutSeconds) + 5) * 1000)
    );

    const stdout = response.output
      .filter((entry) => entry.type === 'stdout' || entry.type === 'output')
      .map((entry) => entry.data)
      .join('');
    const stderr = response.output
      .filter((entry) => entry.type === 'stderr')
      .map((entry) => entry.data)
      .join('');

    return {
      stdout,
      stderr,
      exit_code: response.exit_code ?? (response.status === 'done' ? 0 : 1),
      command,
      interrupted: signal?.aborted === true,
    };
  } catch (err) {
    logger.error({ command, error: getErrorMessage(err) }, 'Failed to execute bash command');
    throw err;
  }
}

export async function executeGrep(
  session: WorkspaceSession,
  pattern: string,
  path?: string,
  include?: string
): Promise<GrepResult> {
  try {
    const searchPath = path || '.';
    if (searchPath.includes('..') || searchPath.startsWith('/')) {
      throw new SandboxError('Path must be relative and cannot contain ".."', 'invalid_path');
    }

    if (include) {
      if (!/^[a-zA-Z0-9_*.?-]+$/.test(include)) {
        throw new SandboxError(
          'Invalid include pattern. Only alphanumeric, *, ?, ., _, and - allowed.',
          'invalid_pattern'
        );
      }
    }

    const matches: Array<{ path: string; line: number; content: string }> = [];
    let stdout = '';
    let exitCode = 0;

    if (isLocalWorkspace(session)) {
      const grepArgs = ['-rn'];
      if (include) {
        grepArgs.push('--include', include);
      }
      grepArgs.push('--', pattern, searchPath);

      const result = await execFileAsync('grep', grepArgs, { cwd: session.workspacePath, timeout: 30_000 });
      stdout = result.stdout;
      exitCode = result.exitCode;
    } else {
      const grepArgs: string[] = ['-rn'];
      if (include) {
        grepArgs.push('--include', include);
      }
      grepArgs.push('--', pattern, searchPath);

      const command = `grep ${grepArgs.map((arg) => shellQuote(String(arg))).join(' ')}`;
      const result = await executeBash(session, command, 30);
      stdout = result.stdout;
      exitCode = result.exit_code;
    }

    // Grep returns exit code 1 when no matches found, which is not an error
    if (exitCode === 1) {
      return { pattern, matches: [] };
    }
    if (exitCode !== 0) {
      throw new SandboxError('grep failed', 'grep_failed');
    }

    const lines = stdout.split('\n').filter((line) => line.trim());
    for (const line of lines) {
      const match = line.match(/^(.+):(\d+):(.*)$/);
      if (match) {
        matches.push({
          path: match[1],
          line: parseInt(match[2], 10),
          content: match[3],
        });
      }
    }

    return { pattern, matches };
  } catch (err) {
    logger.error({ pattern, path, error: getErrorMessage(err) }, 'Failed to execute grep');
    throw err;
  }
}

export async function executeGlob(session: WorkspaceSession, pattern: string, path?: string): Promise<GlobResult> {
  try {
    const searchPath = path || '.';
    if (searchPath.includes('..') || searchPath.startsWith('/')) {
      throw new SandboxError('Path must be relative and cannot contain ".."', 'invalid_path');
    }

    if (!/^[a-zA-Z0-9_*.?/\[\]-]+$/.test(pattern)) {
      throw new SandboxError(
        'Invalid glob pattern. Only alphanumeric, *, ?, ., /, _, [], and - allowed.',
        'invalid_pattern'
      );
    }

    const matcher = globToRegExp(pattern);
    const prefix = searchPath === '.' ? '' : `${searchPath.replace(/\/$/, '')}/`;
    const matches: string[] = [];

    if (isLocalWorkspace(session)) {
      const root = resolveWorkspacePath(session, searchPath);
      const files = listLocalFilesRecursive(root);
      for (const file of files) {
        if (shouldIgnorePath(file)) continue;
        if (!matcher.test(file)) continue;
        matches.push(prefix ? `${prefix}${file}` : file);
        if (matches.length >= 100) break;
      }

      return { pattern, matches };
    }

    const findCommand = `find ${shellQuote(searchPath)} -type f -print | head -2000`;
    const result = await executeBash(session, findCommand, 30);
    const lines = result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.replace(/^\.\//, ''));

    for (const line of lines) {
      const normalized = line.replace(/\\/g, '/');
      const relative = prefix && normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
      if (shouldIgnorePath(relative)) continue;
      if (!matcher.test(relative)) continue;
      matches.push(prefix ? `${prefix}${relative}` : relative);
      if (matches.length >= 100) break;
    }

    return { pattern, matches };
  } catch (err) {
    logger.error({ pattern, path, error: getErrorMessage(err) }, 'Failed to execute glob');
    throw err;
  }
}
