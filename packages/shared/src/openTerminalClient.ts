import { SandboxError } from './errors.js';

export interface OpenTerminalConnection {
  baseUrl: string;
  apiKey: string;
}

const joinUrl = (baseUrl: string, path: string): string => {
  const base = baseUrl.replace(/\/$/, '');
  return path.startsWith('/') ? `${base}${path}` : `${base}/${path}`;
};

export async function openTerminalFetch(
  connection: OpenTerminalConnection,
  path: string,
  init?: RequestInit,
  timeoutMs = 30_000
): Promise<Response> {
  const controller = new AbortController();
  const inputSignal = init?.signal;

  const abortHandler = () => controller.abort();
  if (inputSignal) {
    if (inputSignal.aborted) {
      controller.abort();
    } else {
      inputSignal.addEventListener('abort', abortHandler, { once: true });
    }
  }

  const timeout = Math.max(1, timeoutMs);
  const timer = setTimeout(() => controller.abort(), timeout);
  // Don't keep the process alive just for timeouts.
  (timer as unknown as { unref?: () => void }).unref?.();

  let response: Response;
  try {
    response = await fetch(joinUrl(connection.baseUrl, path), {
      ...init,
      headers: {
        Authorization: `Bearer ${connection.apiKey}`,
        ...(init?.headers ?? {}),
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
    if (inputSignal && !inputSignal.aborted) {
      inputSignal.removeEventListener('abort', abortHandler);
    }
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new SandboxError(
      `Open Terminal request failed (${response.status}): ${body || response.statusText}`,
      'open_terminal_request_failed'
    );
  }

  return response;
}

export async function openTerminalFetchJson<T>(
  connection: OpenTerminalConnection,
  path: string,
  init?: RequestInit,
  timeoutMs?: number
): Promise<T> {
  const response = await openTerminalFetch(connection, path, init, timeoutMs);
  return (await response.json()) as T;
}
