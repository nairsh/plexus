import { mkdirSync, readFileSync, writeFileSync, existsSync, cpSync, rmSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { getDb, logger, SandboxError } from '@orchestrator/shared';

const getWorkspaceRoot = () => resolve(process.env['SANDBOX_WORKSPACE_ROOT'] || './data/workspaces');

interface WorkspaceRecord {
  chat_id: string;
  user_id: string;
  language: 'python' | 'javascript' | 'sql';
  workspace_path: string;
  metadata_path: string;
  status: 'inactive' | 'activating' | 'active' | 'error';
  active_session_id: string | null;
}

const ensureDir = (path: string) => {
  mkdirSync(path, { recursive: true });
};

const getWorkspacePaths = (chatId: string) => {
  const basePath = join(getWorkspaceRoot(), chatId);
  return {
    basePath,
    filesPath: join(basePath, 'files'),
    metadataPath: join(basePath, 'metadata.json'),
  };
};

const upsertWorkspace = (record: WorkspaceRecord) => {
  const db = getDb();
  db.prepare(
    `INSERT INTO sandbox_workspaces (
      chat_id, user_id, active_session_id, language, workspace_path, metadata_path,
      status, last_activated_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(chat_id) DO UPDATE SET
      user_id = excluded.user_id,
      active_session_id = excluded.active_session_id,
      language = excluded.language,
      workspace_path = excluded.workspace_path,
      metadata_path = excluded.metadata_path,
      status = excluded.status,
      updated_at = datetime('now')`
  ).run(
    record.chat_id,
    record.user_id,
    record.active_session_id,
    record.language,
    record.workspace_path,
    record.metadata_path,
    record.status
  );
};

export const ensureWorkspace = (userId: string, chatId: string, language: 'python' | 'javascript' | 'sql') => {
  const paths = getWorkspacePaths(chatId);
  ensureDir(paths.filesPath);

  if (!existsSync(paths.metadataPath)) {
    writeFileSync(
      paths.metadataPath,
      JSON.stringify({ chat_id: chatId, user_id: userId, language, created_at: new Date().toISOString() }, null, 2)
    );
  }

  upsertWorkspace({
    chat_id: chatId,
    user_id: userId,
    language,
    workspace_path: paths.filesPath,
    metadata_path: paths.metadataPath,
    status: 'inactive',
    active_session_id: null,
  });

  return paths;
};

export const activateWorkspace = (userId: string, chatId: string, sessionId: string, language: 'python' | 'javascript' | 'sql', targetDir: string) => {
  const paths = ensureWorkspace(userId, chatId, language);
  ensureDir(targetDir);

  if (existsSync(paths.filesPath)) {
    cpSync(paths.filesPath, targetDir, { recursive: true, force: true });
  }

  upsertWorkspace({
    chat_id: chatId,
    user_id: userId,
    language,
    workspace_path: paths.filesPath,
    metadata_path: paths.metadataPath,
    status: 'active',
    active_session_id: sessionId,
  });

  const db = getDb();
  db.prepare(
    `UPDATE sandbox_sessions
     SET chat_id = ?, environment_status = 'running'
     WHERE id = ?`
  ).run(chatId, sessionId);

  logger.info({ chatId, sessionId, targetDir }, 'Sandbox workspace activated');

  return paths;
};

export const deactivateWorkspace = (sessionId: string, sessionDir: string, persistFromSession = true) => {
  const db = getDb();
  const row = db.prepare(
    `SELECT chat_id, language, user_id FROM sandbox_sessions WHERE id = ?`
  ).get(sessionId) as { chat_id?: string; language: 'python' | 'javascript' | 'sql'; user_id: string } | undefined;

  if (!row?.chat_id) {
    return;
  }

  const paths = ensureWorkspace(row.user_id, row.chat_id, row.language);

  if (persistFromSession) {
    rmSync(paths.filesPath, { recursive: true, force: true });
    ensureDir(dirname(paths.filesPath));
    cpSync(sessionDir, paths.filesPath, { recursive: true, force: true });
  }

  db.prepare(
    `UPDATE sandbox_workspaces
     SET active_session_id = NULL,
         status = 'inactive',
         last_deactivated_at = datetime('now'),
         updated_at = datetime('now')
     WHERE chat_id = ?`
  ).run(row.chat_id);

  db.prepare(
    `UPDATE sandbox_sessions
     SET environment_status = 'stopped'
     WHERE id = ?`
  ).run(sessionId);

  logger.info({ chatId: row.chat_id, sessionId }, 'Sandbox workspace deactivated');
};

export const getWorkspaceInfo = (chatId: string) => {
  const db = getDb();
  const row = db.prepare(
    `SELECT * FROM sandbox_workspaces WHERE chat_id = ?`
  ).get(chatId) as Record<string, unknown> | undefined;

  if (!row) {
    return null;
  }

  return row;
};

export const snapshotWorkspaceFiles = (workspacePath: string): string[] => {
  const results: string[] = [];

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      const relPath = relative(workspacePath, fullPath);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        walk(fullPath);
      } else {
        results.push(relPath);
      }
    }
  };

  if (!existsSync(workspacePath)) {
    return results;
  }

  walk(workspacePath);
  return results;
};

export const readWorkspaceMetadata = (chatId: string) => {
  const info = getWorkspaceInfo(chatId);
  if (!info) {
    throw new SandboxError(`Workspace not found for chat: ${chatId}`, 'workspace_not_found');
  }

  const metadataPath = info['metadata_path'];
  if (typeof metadataPath !== 'string' || !existsSync(metadataPath)) {
    return null;
  }

  return JSON.parse(readFileSync(metadataPath, 'utf-8')) as Record<string, unknown>;
};
