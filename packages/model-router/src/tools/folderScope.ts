import { resolve, relative, isAbsolute } from 'node:path';
import { InvalidRequestError } from '@orchestrator/shared';
import type { AgentRequest } from '@orchestrator/shared';

export const getWorkingDirectoryFromRequest = (request: AgentRequest): string | undefined => {
  const value = request.working_directory?.trim();
  return value ? value : undefined;
};

export const resolveScopedPath = (workingDirectory: string, requestedPath: string): string => {
  return isAbsolute(requestedPath) ? resolve(requestedPath) : resolve(workingDirectory, requestedPath);
};

export const isPathInsideScope = (workingDirectory: string, requestedPath: string): boolean => {
  const scopeRoot = resolve(workingDirectory);
  const target = resolveScopedPath(scopeRoot, requestedPath);
  const rel = relative(scopeRoot, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

export const getFolderApprovalReason = (workingDirectory: string, requestedPath: string): string | null => {
  if (isPathInsideScope(workingDirectory, requestedPath)) return null;
  return `This action targets ${resolveScopedPath(workingDirectory, requestedPath)}, which is outside the allowed folder scope ${resolve(workingDirectory)}.`;
};

export const assertPathWithinScope = (workingDirectory: string, requestedPath: string): void => {
  if (!isPathInsideScope(workingDirectory, requestedPath)) {
    throw new InvalidRequestError('Path is outside the configured working directory', 'working_directory');
  }
};
