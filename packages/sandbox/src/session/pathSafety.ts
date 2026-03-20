import { normalize, resolve } from 'node:path';
import { SandboxError } from '@orchestrator/shared';

export function validatePath(sessionDir: string, requestedPath: string): string {
  const normalized = normalize(requestedPath);
  if (normalized.includes('..') || normalized.startsWith('/')) {
    throw new SandboxError('Path traversal detected: paths must be relative and cannot contain ".."', 'path_traversal');
  }
  const full = resolve(sessionDir, normalized);
  if (!full.startsWith(sessionDir)) {
    throw new SandboxError('Path traversal detected: resolved path is outside workspace', 'path_traversal');
  }
  return full;
}
