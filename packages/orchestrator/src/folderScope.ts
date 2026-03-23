import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { InvalidRequestError } from '@orchestrator/shared';

export const normalizeWorkingDirectory = (workingDirectory?: string): string | undefined => {
  const value = workingDirectory?.trim();
  if (!value) return undefined;
  try {
    return realpathSync(resolve(value));
  } catch {
    throw new InvalidRequestError(`Working directory does not exist: ${value}`, 'working_directory');
  }
};
