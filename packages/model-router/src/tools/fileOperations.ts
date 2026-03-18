import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getErrorMessage, logger, SandboxError } from '@orchestrator/shared';

export interface WorkspaceSession {
  containerName: string;
  apiKey: string;
  baseUrl: string;
  workspacePath: string;
}

export interface FileReadResult {
  content: string;
  path: string;
  isDirectory?: boolean;
  entries?: string[];
}

export interface FileWriteResult {
  path: string;
  bytes_written: number;
}

export interface FileEditResult {
  path: string;
  success: boolean;
  oldString: string;
  newString: string;
}

export interface BashResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  command: string;
  interrupted?: boolean;
}

export interface GrepResult {
  pattern: string;
  matches: Array<{
    path: string;
    line: number;
    content: string;
  }>;
}

export interface GlobResult {
  pattern: string;
  matches: string[];
}

const otFetch = async <T>(session: WorkspaceSession, path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(`${session.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${session.apiKey}`,
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new SandboxError(
      `Open Terminal request failed (${response.status}): ${body || response.statusText}`,
      'open_terminal_request_failed'
    );
  }

  return (await response.json()) as T;
};

const useLocalWorkspace = (session: WorkspaceSession): boolean => !session.baseUrl;

const resolveWorkspacePath = (session: WorkspaceSession, filePath: string): string => {
  const target = resolve(session.workspacePath, filePath.replace(/^\/home\/user\/?/, ''));
  if (!target.startsWith(resolve(session.workspacePath))) {
    throw new SandboxError('Path traversal detected for workspace file operation', 'path_traversal');
  }
  return target;
};

const listLocalFilesRecursive = (baseDir: string, currentDir = baseDir, prefix = ''): string[] => {
  const entries = readdirSync(currentDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const fullPath = resolve(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listLocalFilesRecursive(baseDir, fullPath, relPath));
    } else {
      files.push(relPath);
    }
  }

  return files;
};

const escapeRegex = (value: string): string => value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');

const globToRegExp = (pattern: string): RegExp => {
  let regex = '^';

  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    const next = pattern[i + 1];

    if (char === '*' && next === '*') {
      regex += '.*';
      i++;
      continue;
    }

    if (char === '*') {
      regex += '[^/]*';
      continue;
    }

    if (char === '?') {
      regex += '.';
      continue;
    }

    regex += escapeRegex(char);
  }

  regex += '$';
  return new RegExp(regex);
};

export async function executeReadFile(
  session: WorkspaceSession,
  filePath: string,
  limit?: number,
  offset?: number
): Promise<FileReadResult> {
  try {
    if (useLocalWorkspace(session)) {
      const fullPath = resolveWorkspacePath(session, filePath);
      const stats = statSync(fullPath, { throwIfNoEntry: false });
      if (!stats) {
        throw new SandboxError(`File not found: ${filePath}`, 'file_read_failed');
      }

      if (stats.isDirectory()) {
        return {
          path: filePath,
          isDirectory: true,
          entries: readdirSync(fullPath),
          content: '',
        };
      }

      const content = readFileSync(fullPath, 'utf-8');
      const lines = content.split('\n');
      const start = Math.max(0, (offset ?? 1) - 1);
      const end = limit ? start + limit : undefined;
      return {
        path: filePath,
        content: lines.slice(start, end).join('\n'),
      };
    }

    // Try to read as file first
    const response = await fetch(
      `${session.baseUrl}/files/read?path=${encodeURIComponent(filePath)}${limit ? `&limit=${limit}` : ''}${offset ? `&offset=${offset}` : ''}`,
      {
        headers: { Authorization: `Bearer ${session.apiKey}` },
        signal: AbortSignal.timeout(15_000),
      }
    );

    if (response.ok) {
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('application/json')) {
        const body = (await response.json()) as { content?: string; entries?: Array<{ name: string; type: string }> };
        if (body.entries) {
          return {
            path: filePath,
            isDirectory: true,
            entries: body.entries.map((e) => e.name),
            content: '',
          };
        }
        return {
          path: filePath,
          content: body.content ?? '',
        };
      }
      return {
        path: filePath,
        content: Buffer.from(await response.arrayBuffer()).toString('utf-8'),
      };
    }

    // If file read fails, try listing directory
    if (response.status === 404 || response.status === 400) {
      const listResponse = await otFetch<{ entries: Array<{ name: string; type: string }> }>(
        session,
        `/files/list?directory=${encodeURIComponent(filePath)}`
      );
      return {
        path: filePath,
        isDirectory: true,
        entries: listResponse.entries.map((e) => e.name),
        content: '',
      };
    }

    throw new SandboxError(`Failed to read ${filePath}: ${response.statusText}`, 'file_read_failed');
  } catch (err) {
    logger.error({ path: filePath, error: getErrorMessage(err) }, 'Failed to read file');
    throw err;
  }
}

export async function executeWriteFile(
  session: WorkspaceSession,
  filePath: string,
  content: string
): Promise<FileWriteResult> {
  try {
    if (useLocalWorkspace(session)) {
      const fullPath = resolveWorkspacePath(session, filePath);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, content, 'utf-8');
      return {
        path: filePath,
        bytes_written: Buffer.byteLength(content, 'utf-8'),
      };
    }

    await otFetch(session, '/files/write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath, content }),
    });

    return {
      path: filePath,
      bytes_written: Buffer.byteLength(content, 'utf-8'),
    };
  } catch (err) {
    logger.error({ path: filePath, error: getErrorMessage(err) }, 'Failed to write file');
    throw err;
  }
}

export async function executeEditFile(
  session: WorkspaceSession,
  filePath: string,
  oldString: string,
  newString: string
): Promise<FileEditResult> {
  try {
    // First read the file
    const readResult = await executeReadFile(session, filePath);
    const currentContent = readResult.content;

    // Check if oldString exists exactly
    if (!currentContent.includes(oldString)) {
      throw new SandboxError(
        `oldString not found in file. The file may have changed or the string may be incorrect.`,
        'edit_oldstring_not_found'
      );
    }

    // Count occurrences to warn about multiple matches
    const occurrences = currentContent.split(oldString).length - 1;
    if (occurrences > 1) {
      logger.warn({ path: filePath, occurrences }, 'Multiple occurrences of oldString found, replacing all');
    }

    // Replace all occurrences
    const newContent = currentContent.replaceAll(oldString, newString);

    // Write the updated content
    await executeWriteFile(session, filePath, newContent);

    return {
      path: filePath,
      success: true,
      oldString,
      newString,
    };
  } catch (err) {
    logger.error({ path: filePath, error: getErrorMessage(err) }, 'Failed to edit file');
    throw err;
  }
}

export async function executeBash(
  session: WorkspaceSession,
  command: string,
  timeoutSeconds: number = 60,
  signal?: AbortSignal
): Promise<BashResult> {
  try {
    if (useLocalWorkspace(session)) {
      const { execFile } = await import('node:child_process');

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

    const response = await otFetch<{
      status: string;
      exit_code: number | null;
      output: Array<{ type: string; data: string }>;
    }>(session, `/execute?wait=${Math.max(1, timeoutSeconds)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command }),
      signal,
    });

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
    // Use OpenTerminal's bash execution which properly handles command execution
    // Build command arguments array to avoid shell injection
    const grepArgs = ['-rn'];

    if (include) {
      // Validate include pattern - only allow safe glob characters
      if (!/^[a-zA-Z0-9_*.?-]+$/.test(include)) {
        throw new SandboxError(
          'Invalid include pattern. Only alphanumeric, *, ?, ., _, and - allowed.',
          'invalid_pattern'
        );
      }
      grepArgs.push('--include', include);
    }

    // Pass pattern as a literal string argument
    grepArgs.push('--', pattern);

    // Validate path - must be relative and safe
    const searchPath = path || '.';
    if (searchPath.includes('..') || searchPath.startsWith('/')) {
      throw new SandboxError('Path must be relative and cannot contain ".."', 'invalid_path');
    }
    grepArgs.push(searchPath);

    // Use JSON.stringify to safely pass the array as a single argument to bash -c
    const command = `grep ${grepArgs
      .map((arg) =>
        // Escape single quotes and wrap in single quotes for safety
        typeof arg === 'string' ? "'" + arg.replace(/'/g, "'\"'\"'") + "'" : arg
      )
      .join(' ')}`;

    const result = await executeBash(session, command, 30);

    const matches: Array<{ path: string; line: number; content: string }> = [];

    // Parse grep output: path:line:content
    const lines = result.stdout.split('\n').filter((line) => line.trim());
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

    return {
      pattern,
      matches,
    };
  } catch (err) {
    // Grep returns exit code 1 when no matches found, which is not an error
    if (getErrorMessage(err).includes('exit code 1')) {
      return {
        pattern,
        matches: [],
      };
    }
    logger.error({ pattern, path, error: getErrorMessage(err) }, 'Failed to execute grep');
    throw err;
  }
}

export async function executeGlob(session: WorkspaceSession, pattern: string, path?: string): Promise<GlobResult> {
  try {
    // Validate inputs to prevent injection
    const searchPath = path || '.';
    if (searchPath.includes('..') || searchPath.startsWith('/')) {
      throw new SandboxError('Path must be relative and cannot contain ".."', 'invalid_path');
    }

    // Validate pattern - only allow safe glob characters
    if (!/^[a-zA-Z0-9_*.?/\[\]-]+$/.test(pattern)) {
      throw new SandboxError(
        'Invalid glob pattern. Only alphanumeric, *, ?, ., /, _, [], and - allowed.',
        'invalid_pattern'
      );
    }

    let matches: string[];

    if (useLocalWorkspace(session)) {
      const root = resolveWorkspacePath(session, searchPath);
      const matcher = globToRegExp(pattern);
      matches = listLocalFilesRecursive(root)
        .filter((file) => matcher.test(file))
        .slice(0, 100)
        .map((file) => (searchPath === '.' ? file : `${searchPath.replace(/\/$/, '')}/${file}`));
    } else {
      const command = `find '${searchPath.replace(/'/g, "'\"'\"'")}' -type f -name '${pattern.replace(/'/g, "'\"'\"'")}' 2>/dev/null | head -100`;
      const result = await executeBash(session, command, 30);
      matches = result.stdout
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => line.replace(/^\.\//, ''));
    }

    return {
      pattern,
      matches,
    };
  } catch (err) {
    logger.error({ pattern, path, error: getErrorMessage(err) }, 'Failed to execute glob');
    throw err;
  }
}
