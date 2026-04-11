import { decryptJson, getDb, logger, parseRowOrNull, SandboxSessionRowSchema } from '@orchestrator/shared';
import type { WorkspaceSession } from './fileOperations.js';

const activeSessions = new Map<string, WorkspaceSession>();

const cacheKey = (userId: string, chatId: string): string => `${userId}:${chatId}`;

export async function getOpenTerminalSessionForChat(userId: string, chatId: string): Promise<WorkspaceSession | null> {
  const key = cacheKey(userId, chatId);
  // Check cache first
  if (activeSessions.has(key)) {
    const cached = activeSessions.get(key)!;
    if (!cached.baseUrl) return cached; // local workspace — no health check needed
    // Verify remote session is still healthy
    try {
      const response = await fetch(`${cached.baseUrl}/health`, {
        signal: AbortSignal.timeout(3_000),
      });
      if (response.ok) {
        return cached;
      }
    } catch {
      // Session is dead, remove from cache
      activeSessions.delete(key);
    }
  }

  // Look up active session from DB
  const db = getDb();
  const row = parseRowOrNull(
    SandboxSessionRowSchema,
    db
      .prepare(
        `SELECT s.id, s.open_terminal_url, s.open_terminal_api_key, s.chat_id, s.status, s.environment_status, s.working_dir, w.workspace_path
         FROM sandbox_sessions s
        LEFT JOIN sandbox_workspaces w ON w.chat_id = s.chat_id AND w.user_id = s.user_id
        WHERE s.chat_id = ? AND s.user_id = ? AND s.status IN ('ready', 'executing')
        ORDER BY s.created_at DESC LIMIT 1`
      )
      .get(chatId, userId)
  );

  if (!row) {
    return null;
  }

  if (row.environment_status !== 'running') {
    logger.warn({ chatId, environmentStatus: row.environment_status }, 'Workspace session is not running');
    return null;
  }

  if (!row.open_terminal_url) {
    const localWorkspacePath = row.workspace_path ?? row.working_dir;
    if (!localWorkspacePath) {
      return null;
    }
    // Local workspace mode (no container)
    return {
      containerName: `local-${chatId}`,
      apiKey: '',
      baseUrl: '',
      workspacePath: localWorkspacePath,
      // workingDirectory should only be set when the user explicitly scopes to one.
      // For default chat workspaces we run directly in workspacePath.
      workingDirectory: undefined,
    };
  }

  // Read API key from DB. It may be encrypted (base64 blob) or legacy plaintext.
  const rawKey = row.open_terminal_api_key;
  if (!rawKey) {
    logger.warn({ chatId, sessionId: row.id }, 'No API key stored for OpenTerminal session');
    return null;
  }
  let apiKey: string;
  const decrypted = decryptJson<string>(rawKey);
  if (decrypted !== null) {
    apiKey = decrypted;
  } else {
    // Legacy plaintext key — use as-is.
    apiKey = rawKey;
    logger.debug({ chatId, sessionId: row.id }, 'Using legacy plaintext API key from DB');
  }

  const workspacePath = row.workspace_path ?? '/home/user';

  const session: WorkspaceSession = {
    containerName: `open-terminal-${chatId}`,
    apiKey,
    baseUrl: row.open_terminal_url,
    workspacePath,
    // Open Terminal commands run inside the container workspace.
    // Host-side absolute paths are not valid container paths.
    workingDirectory: undefined,
  };

  // Cache it
  activeSessions.set(key, session);

  return session;
}

export function invalidateSessionCache(userId: string, chatId: string): void {
  activeSessions.delete(cacheKey(userId, chatId));
}
