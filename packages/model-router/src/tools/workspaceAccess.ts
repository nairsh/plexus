import { getDb, getErrorMessage, logger } from '@orchestrator/shared';
import type { WorkspaceSession } from './fileOperations.js';

interface SandboxSessionRow {
  id: string;
  open_terminal_url: string | null;
  open_terminal_api_key: string | null;
  chat_id: string;
  status: string;
  environment_status: string;
  workspace_path: string | null;
}

const activeSessions = new Map<string, WorkspaceSession>();

export async function getOpenTerminalSessionForChat(chatId: string): Promise<WorkspaceSession | null> {
  // Check cache first
  if (activeSessions.has(chatId)) {
    const cached = activeSessions.get(chatId)!;
    // Verify it's still healthy
    try {
      const response = await fetch(`${cached.baseUrl}/health`, {
        signal: AbortSignal.timeout(3_000),
      });
      if (response.ok) {
        return cached;
      }
    } catch {
      // Session is dead, remove from cache
      activeSessions.delete(chatId);
    }
  }

  // Look up active session from DB
  const db = getDb();
  const row = db
    .prepare(
      `SELECT s.id, s.open_terminal_url, s.open_terminal_api_key, s.chat_id, s.status, s.environment_status, w.workspace_path
     FROM sandbox_sessions s
     LEFT JOIN sandbox_workspaces w ON w.chat_id = s.chat_id
     WHERE s.chat_id = ? AND s.status IN ('ready', 'executing')
     ORDER BY s.created_at DESC LIMIT 1`
    )
    .get(chatId) as SandboxSessionRow | undefined;

  if (!row) {
    return null;
  }

  if (row.environment_status !== 'running') {
    logger.warn({ chatId, environmentStatus: row.environment_status }, 'Workspace session is not running');
    return null;
  }

  if (!row.open_terminal_url) {
    if (!row.workspace_path) {
      return null;
    }
    // Local workspace mode (no container)
    return {
      containerName: `local-${chatId}`,
      apiKey: '',
      baseUrl: '',
      workspacePath: row.workspace_path,
    };
  }

  // Read API key directly from DB (stored when container was started)
  const apiKey = row.open_terminal_api_key;
  if (!apiKey) {
    logger.warn({ chatId, sessionId: row.id }, 'No API key stored for OpenTerminal session');
    return null;
  }

  const workspacePath = row.workspace_path ?? '/home/user';

  const session: WorkspaceSession = {
    containerName: `open-terminal-${chatId}`,
    apiKey,
    baseUrl: row.open_terminal_url,
    workspacePath,
  };

  // Cache it
  activeSessions.set(chatId, session);

  return session;
}

export function invalidateSessionCache(chatId: string): void {
  activeSessions.delete(chatId);
}
