/**
 * Command approval logic for bash tool execution.
 * Determines whether a command requires user approval before running.
 */
import type { AgentRequest, ToolApprovalDecision } from '@orchestrator/shared';

const trivialCommandPattern =
  /^\s*(pwd|ls|la|ll|dir|which|whereis|whoami|git status|git diff|git log|node -v|npm -v|pnpm -v)(\s+.*)?$/i;

const normalizeCommandKey = (command: string): string => command.trim().split(/\s+/)[0]?.toLowerCase() ?? 'bash';

export const getCommandApprovalReason = (command: string): string | null => {
  const trimmed = command.trim();
  if (!trimmed) return 'Empty command';
  if (trivialCommandPattern.test(trimmed)) return null;
  return 'This command can modify files, install dependencies, or change repository state.';
};

export const requestCommandApproval = async (request: AgentRequest, command: string): Promise<ToolApprovalDecision> => {
  const reason = getCommandApprovalReason(command);
  if (!reason) return 'approve';
  if (!request.trace?.onToolApprovalRequest) return 'approve';
  return request.trace.onToolApprovalRequest({
    name: 'bash',
    input: { command },
    reason,
    command_key: normalizeCommandKey(command),
    model: request.trace.model,
    workflow_id: request.trace.workflow_id,
    subagent_id: request.trace.subagent_id,
  });
};
