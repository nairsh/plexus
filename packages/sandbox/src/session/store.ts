import type { ChildProcess } from 'node:child_process';
import type { SandboxConfig } from '@orchestrator/shared';
import { SandboxError } from '@orchestrator/shared';
import type { OpenTerminalSession } from '../openTerminal.js';

export interface SessionState {
  id: string;
  userId: string;
  chatId: string | null;
  language: string;
  workingDir: string;
  ephemeral: boolean;
  status: 'creating' | 'ready' | 'executing' | 'terminated' | 'error';
  environmentStatus: 'stopped' | 'starting' | 'running';
  config: SandboxConfig;
  createdAt: number;
  runningProcess: ChildProcess | null;
  openTerminal: OpenTerminalSession | null;
}

export const sessions = new Map<string, SessionState>();

export function getSessionOrThrow(sessionId: string): SessionState {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new SandboxError(`Session not found: ${sessionId}`, 'session_not_found');
  }
  if (session.status === 'terminated') {
    throw new SandboxError(`Session has been terminated: ${sessionId}`, 'session_terminated');
  }
  return session;
}
