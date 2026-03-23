import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { SandboxError } from '@orchestrator/shared';
import type { WorkspaceSession } from './types.js';
import { assertPathWithinScope } from '../folderScope.js';

const IGNORED_DIRS = new Set(['node_modules', '.git', '.packages', 'dist']);

export const isLocalWorkspace = (session: WorkspaceSession): boolean => !session.baseUrl;

export const resolveWorkspacePath = (session: WorkspaceSession, filePath: string): string => {
  if (session.workingDirectory) {
    assertPathWithinScope(session.workingDirectory, filePath);
  }
  const target = resolve(session.workspacePath, filePath.replace(/^\/home\/user\/?/, ''));
  if (!target.startsWith(resolve(session.workspacePath))) {
    throw new SandboxError('Path traversal detected for workspace file operation', 'path_traversal');
  }
  return target;
};

export const listLocalFilesRecursive = (baseDir: string, currentDir = baseDir, prefix = ''): string[] => {
  const entries = readdirSync(currentDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) {
      continue;
    }

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

export const globToRegExp = (pattern: string): RegExp => {
  let regex = '^';

  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    const next = pattern[i + 1];

    if (char === '*' && next === '*') {
      const after = pattern[i + 2];
      if (after === '/') {
        // "**/" matches zero or more nested directories.
        regex += '(?:.*\\/)?';
        i += 2;
        continue;
      }

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

export const shouldIgnorePath = (relativePath: string): boolean => {
  const normalized = relativePath.replace(/\\/g, '/');
  return (
    normalized.startsWith('node_modules/') ||
    normalized.includes('/node_modules/') ||
    normalized.startsWith('.git/') ||
    normalized.includes('/.git/') ||
    normalized.startsWith('.packages/') ||
    normalized.includes('/.packages/') ||
    normalized.startsWith('dist/') ||
    normalized.includes('/dist/')
  );
};
