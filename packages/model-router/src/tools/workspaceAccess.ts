import { getDb, logger, SandboxError } from '@orchestrator/shared';
import type { WorkspaceSession } from './fileOperations.js';

interface SandboxSessionRow {
  id: string;
  open_terminal_url: string | null;
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
        signal: AbortSignal.timeout(3_000) 
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
  const row = db.prepare(
    `SELECT s.id, s.open_terminal_url, s.chat_id, s.status, s.environment_status, w.workspace_path
     FROM sandbox_sessions s
     LEFT JOIN sandbox_workspaces w ON w.chat_id = s.chat_id
     WHERE s.chat_id = ? AND s.status IN ('ready', 'executing')
     ORDER BY s.created_at DESC LIMIT 1`
  ).get(chatId) as SandboxSessionRow | undefined;

  if (row && row.environment_status !== 'running') {
    logger.warn({ chatId, environmentStatus: row.environment_status }, 'Workspace session is not running');
    return null;
  }

  if (!row) {
    return null;
  }

  if (!row.open_terminal_url) {
    if (!row.workspace_path) {
      return null;
    }

    return {
      containerName: `local-${chatId}`,
      apiKey: '',
      baseUrl: '',
      workspacePath: row.workspace_path,
    };
  }

  // We need to get the API key. For security, we'll query the container or use a stored key.
  // Since we don't store the API key in DB for security, we'll need to extract it from the running container
  // or use a different approach. For now, we'll need to look up the container name from Docker.
  
  try {
    // Extract port from URL
    const url = new URL(row.open_terminal_url);
    const port = url.port;
    
    // Find container by port mapping
    const { execFileSync } = await import('node:child_process');
    const containerOutput = execFileSync('docker', [
      'ps', 
      '--filter', `publish=${port}`,
      '--format', '{{.Names}}'
    ], { encoding: 'utf-8' }).trim();
    
    if (!containerOutput) {
      logger.warn({ chatId, port }, 'Could not find OpenTerminal container');
      return null;
    }
    
    const containerName = containerOutput.split('\n')[0];
    
    // Get API key from container env
    const envOutput = execFileSync('docker', [
      'inspect',
      '--format', '{{range .Config.Env}}{{println .}}{{end}}',
      containerName
    ], { encoding: 'utf-8' });
    
    const apiKeyMatch = envOutput.match(/OPEN_TERMINAL_API_KEY=(.+)/);
    const apiKey = apiKeyMatch?.[1];
    
    if (!apiKey) {
      logger.warn({ chatId, containerName }, 'Could not extract API key from container');
      return null;
    }

    // Get workspace path
    const workspacePath = await getWorkspacePathForChat(chatId);

    const session: WorkspaceSession = {
      containerName,
      apiKey,
      baseUrl: row.open_terminal_url,
      workspacePath: workspacePath || '/home/user',
    };

    // Cache it
    activeSessions.set(chatId, session);
    
    return session;
  } catch (err) {
    logger.error({ chatId, error: (err as Error).message }, 'Failed to reconstruct OpenTerminal session');
    return null;
  }
}

async function getWorkspacePathForChat(chatId: string): Promise<string | null> {
  const db = getDb();
  const row = db.prepare(
    `SELECT workspace_path FROM sandbox_workspaces WHERE chat_id = ?`
  ).get(chatId) as { workspace_path: string } | undefined;
  
  return row?.workspace_path || null;
}

export function invalidateSessionCache(chatId: string): void {
  activeSessions.delete(chatId);
}
