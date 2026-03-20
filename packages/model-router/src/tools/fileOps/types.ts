import type { OpenTerminalConnection } from '@orchestrator/shared';

export interface WorkspaceSession extends OpenTerminalConnection {
  containerName: string;
  workspacePath: string;
}

export interface FileReadResult {
  content: string;
  path: string;
  isDirectory?: boolean;
  entries?: string[];
}

export interface FileWriteResult {
  path: string;
  bytes_written: number;
  lint?: { errors: number; warnings: number; summary: string };
}

export interface FileEditResult {
  path: string;
  success: boolean;
  oldString: string;
  newString: string;
  lint?: { errors: number; warnings: number; summary: string };
}

export interface BashResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  command: string;
  interrupted?: boolean;
}

export interface GrepResult {
  pattern: string;
  matches: Array<{
    path: string;
    line: number;
    content: string;
  }>;
}

export interface GlobResult {
  pattern: string;
  matches: string[];
}
