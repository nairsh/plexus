import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { openTerminalFetch, openTerminalFetchJson, SandboxError, getEnv, logger } from '@orchestrator/shared';
import type { ExecutionResult } from '@orchestrator/shared';
import type { OpenTerminalConnection } from '@orchestrator/shared';

export interface OpenTerminalSession extends OpenTerminalConnection {
  containerName: string;
  workspacePath: string;
}

const runDocker = (args: string[]): string => {
  try {
    return execFileSync('docker', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    const err = error as Error & { stderr?: string };
    throw new SandboxError(err.stderr?.trim() || err.message, 'open_terminal_docker_error');
  }
};

const sanitizeName = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .slice(0, 40);

const waitForHealth = async (baseUrl: string) => {
  const deadline = Date.now() + getEnv().OPEN_TERMINAL_START_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3_000) });
      if (response.ok) {
        return;
      }
    } catch {
      // Retry until deadline.
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new SandboxError(`Timed out waiting for Open Terminal at ${baseUrl}`, 'open_terminal_timeout');
};

export const startOpenTerminal = async (chatId: string, workspacePath: string): Promise<OpenTerminalSession> => {
  const containerName = `orchestrator-${sanitizeName(chatId)}-${randomUUID().slice(0, 6)}`;
  const apiKey = `sk-ot-${randomUUID().replace(/-/g, '')}`;
  runDocker([
    'run',
    '-d',
    '--rm',
    '--name',
    containerName,
    '-p',
    `${getEnv().OPEN_TERMINAL_HOST}::8000`,
    '-v',
    `${workspacePath}:/home/user`,
    '-e',
    `OPEN_TERMINAL_API_KEY=${apiKey}`,
    '-e',
    `OPEN_TERMINAL_INFO=Persistent workspace for chat ${chatId}`,
    getEnv().OPEN_TERMINAL_IMAGE,
  ]);

  const portInfo = runDocker(['port', containerName, '8000/tcp']);
  const port = portInfo.split(':').pop()?.trim();
  if (!port) {
    throw new SandboxError(
      `Failed to determine mapped port for container ${containerName}`,
      'open_terminal_port_error'
    );
  }

  const baseUrl = `http://${getEnv().OPEN_TERMINAL_HOST}:${port}`;
  await waitForHealth(baseUrl);

  logger.info({ chatId, containerName, baseUrl }, 'Open Terminal environment started');

  return {
    containerName,
    apiKey,
    baseUrl,
    workspacePath,
  };
};

export const stopOpenTerminal = (session: OpenTerminalSession): void => {
  try {
    runDocker(['stop', session.containerName]);
  } catch (error) {
    logger.warn(
      { containerName: session.containerName, error: (error as Error).message },
      'Failed to stop Open Terminal container'
    );
  }
};

export const executeInOpenTerminal = async (
  session: OpenTerminalSession,
  language: string,
  code: string,
  timeoutSeconds: number
): Promise<ExecutionResult> => {
  const extension = language === 'python' ? 'py' : language === 'javascript' ? 'js' : 'sql';
  const filename = `_script.${extension}`;

  await openTerminalFetchJson(session, '/files/write', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: filename, content: code }),
  });

  const command =
    language === 'python'
      ? `python3 ${filename}`
      : language === 'javascript'
        ? `node ${filename}`
        : `sqlite3 :memory: < ${filename}`;

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
    execution_time_ms: 0,
    files_modified: [filename],
  };
};

export const readOpenTerminalFile = async (session: OpenTerminalSession, filePath: string): Promise<Buffer> => {
  const response = await openTerminalFetch(
    session,
    `/files/read?path=${encodeURIComponent(filePath)}`,
    undefined,
    15_000
  );

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const body = (await response.json()) as { content?: string };
    return Buffer.from(body.content ?? '', 'utf-8');
  }

  return Buffer.from(await response.arrayBuffer());
};

export const writeOpenTerminalFile = async (
  session: OpenTerminalSession,
  filePath: string,
  content: Buffer
): Promise<void> => {
  await openTerminalFetchJson(session, '/files/write', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: filePath, content: content.toString('utf-8') }),
  });
};

export const listOpenTerminalFiles = async (session: OpenTerminalSession, directory = '.'): Promise<string[]> => {
  const response = await openTerminalFetchJson<{ entries: Array<{ name: string }> }>(
    session,
    `/files/list?directory=${encodeURIComponent(directory)}`
  );

  return response.entries.map((entry) => entry.name);
};
