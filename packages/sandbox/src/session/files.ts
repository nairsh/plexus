import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SandboxError } from '@orchestrator/shared';
import { listOpenTerminalFiles, readOpenTerminalFile, writeOpenTerminalFile } from '../openTerminal.js';
import { listFilesRecursive } from './fileListing.js';
import { validatePath } from './pathSafety.js';
import { getSessionOrThrow } from './store.js';

export async function readSandboxFile(sessionId: string, filePath: string): Promise<Buffer> {
  const session = getSessionOrThrow(sessionId);

  if (session.openTerminal) {
    return readOpenTerminalFile(session.openTerminal, filePath);
  }

  const fullPath = validatePath(session.workingDir, filePath);

  try {
    return readFileSync(fullPath);
  } catch {
    throw new SandboxError(`File not found: ${filePath}`, 'file_not_found');
  }
}

const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50MB limit per file

export async function writeSandboxFile(sessionId: string, filePath: string, content: Buffer): Promise<void> {
  if (content.length > MAX_FILE_SIZE_BYTES) {
    throw new SandboxError(
      `File too large: ${(content.length / 1024 / 1024).toFixed(1)}MB exceeds ${MAX_FILE_SIZE_BYTES / 1024 / 1024}MB limit`,
      'file_too_large'
    );
  }

  const session = getSessionOrThrow(sessionId);

  if (session.openTerminal) {
    await writeOpenTerminalFile(session.openTerminal, filePath, content);
    return;
  }

  const fullPath = validatePath(session.workingDir, filePath);
  const dir = join(fullPath, '..');
  mkdirSync(dir, { recursive: true });
  writeFileSync(fullPath, content);
}

export async function listSandboxFiles(sessionId: string, directory?: string): Promise<string[]> {
  const session = getSessionOrThrow(sessionId);

  if (session.openTerminal) {
    return listOpenTerminalFiles(session.openTerminal, directory);
  }

  const targetDir = directory ? validatePath(session.workingDir, directory) : session.workingDir;
  return listFilesRecursive(targetDir);
}
