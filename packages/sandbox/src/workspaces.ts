import { mkdirSync, readFileSync, writeFileSync, existsSync, cpSync, rmSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { getDb, logger, SandboxError } from '@orchestrator/shared';

// Read directly (not via cached getEnv()) so tests can override SANDBOX_WORKSPACE_ROOT at runtime.
const getWorkspaceRoot = () => resolve(process.env['SANDBOX_WORKSPACE_ROOT'] ?? './data/workspaces');

interface WorkspaceRecord {
  chat_id: string;
  user_id: string;
  language: 'python' | 'javascript' | 'sql';
  workspace_path: string;
  metadata_path: string;
  status: 'inactive' | 'activating' | 'active' | 'error';
  active_session_id: string | null;
}

interface WorkspaceMetadata extends Record<string, unknown> {
  created_files?: string[];
  session_file_baselines?: Record<string, string[]>;
}

const ensureDir = (path: string) => {
  mkdirSync(path, { recursive: true });
};

const safePathSegment = (value: string): string => value.replace(/[^a-zA-Z0-9._-]/g, '_');

const toStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
};

const toSessionBaselines = (value: unknown): Record<string, string[]> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

  const baselines = value as Record<string, unknown>;
  const result: Record<string, string[]> = {};
  for (const [sessionId, entries] of Object.entries(baselines)) {
    result[sessionId] = toStringArray(entries);
  }

  return result;
};

const readMetadataFile = (metadataPath: string): WorkspaceMetadata => {
  if (!existsSync(metadataPath)) return {};

  try {
    const parsed = JSON.parse(readFileSync(metadataPath, 'utf-8')) as Record<string, unknown>;
    return {
      ...parsed,
      created_files: toStringArray(parsed['created_files']),
      session_file_baselines: toSessionBaselines(parsed['session_file_baselines']),
    };
  } catch {
    return {};
  }
};

const writeMetadataFile = (metadataPath: string, metadata: WorkspaceMetadata): void => {
  writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
};

export const getWorkspacePaths = (userId: string, chatId: string) => {
  const basePath = join(getWorkspaceRoot(), safePathSegment(userId), safePathSegment(chatId));
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
    ON CONFLICT(user_id, chat_id) DO UPDATE SET
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
  const paths = getWorkspacePaths(userId, chatId);
  ensureDir(paths.filesPath);

  if (!existsSync(paths.metadataPath)) {
    writeMetadataFile(paths.metadataPath, {
      chat_id: chatId,
      user_id: userId,
      language,
      created_at: new Date().toISOString(),
      created_files: [],
      session_file_baselines: {},
    });
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

export const activateWorkspace = (
  userId: string,
  chatId: string,
  sessionId: string,
  language: 'python' | 'javascript' | 'sql',
  targetDir: string
) => {
  const paths = ensureWorkspace(userId, chatId, language);
  ensureDir(targetDir);

  if (existsSync(paths.filesPath)) {
    cpSync(paths.filesPath, targetDir, { recursive: true, force: true });
  }

  const metadata = readMetadataFile(paths.metadataPath);
  const baselines = toSessionBaselines(metadata.session_file_baselines);
  baselines[sessionId] = snapshotWorkspaceFiles(paths.filesPath);
  metadata.session_file_baselines = baselines;
  writeMetadataFile(paths.metadataPath, metadata);

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
  const row = db.prepare(`SELECT chat_id, language, user_id FROM sandbox_sessions WHERE id = ?`).get(sessionId) as
    | { chat_id?: string; language: 'python' | 'javascript' | 'sql'; user_id: string }
    | undefined;

  if (!row?.chat_id) {
    return;
  }

  const paths = ensureWorkspace(row.user_id, row.chat_id, row.language);

  if (persistFromSession) {
    rmSync(paths.filesPath, { recursive: true, force: true });
    ensureDir(dirname(paths.filesPath));
    cpSync(sessionDir, paths.filesPath, { recursive: true, force: true });
  }

  const metadata = readMetadataFile(paths.metadataPath);
  const baselines = toSessionBaselines(metadata.session_file_baselines);
  const baseline = baselines[sessionId];

  if (baseline) {
    const currentFiles = snapshotWorkspaceFiles(paths.filesPath);
    const baselineSet = new Set(baseline);
    const currentSet = new Set(currentFiles);
    const createdSinceActivation = currentFiles.filter((filePath) => !baselineSet.has(filePath));
    const previouslyTracked = toStringArray(metadata.created_files);
    metadata.created_files = Array.from(new Set([...previouslyTracked, ...createdSinceActivation]))
      .filter((filePath) => currentSet.has(filePath))
      .sort();
  }

  delete baselines[sessionId];
  metadata.session_file_baselines = baselines;
  writeMetadataFile(paths.metadataPath, metadata);

  db.prepare(
    `UPDATE sandbox_workspaces
     SET active_session_id = NULL,
         status = 'inactive',
         last_deactivated_at = datetime('now'),
         updated_at = datetime('now')
     WHERE user_id = ? AND chat_id = ?`
  ).run(row.user_id, row.chat_id);

  db.prepare(
    `UPDATE sandbox_sessions
     SET environment_status = 'stopped'
     WHERE id = ?`
  ).run(sessionId);

  logger.info({ chatId: row.chat_id, sessionId }, 'Sandbox workspace deactivated');
};

export const getWorkspaceInfo = (userId: string, chatId: string) => {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM sandbox_workspaces WHERE user_id = ? AND chat_id = ?`).get(userId, chatId) as
    | Record<string, unknown>
    | undefined;

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

export const readWorkspaceMetadata = (userId: string, chatId: string) => {
  const info = getWorkspaceInfo(userId, chatId);
  if (!info) {
    throw new SandboxError(`Workspace not found for chat: ${chatId}`, 'workspace_not_found');
  }

  const metadataPath = info['metadata_path'];
  if (typeof metadataPath !== 'string' || !existsSync(metadataPath)) {
    return null;
  }

  return readMetadataFile(metadataPath);
};
