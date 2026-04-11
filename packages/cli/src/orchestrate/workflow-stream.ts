import chalk from 'chalk';
import type { WorkflowTaskPlanEntry, WorkflowEvent, OrchestratorThinkingData } from '@orchestrator/shared';
import { getErrorMessage } from '@orchestrator/shared';
import { executeWorkflow } from '@orchestrator/orchestrator';
import { ChatApp as ChatScreen } from '../ui/chat-app-bridge.js';
import type { ApprovalRequestState, ClarificationRequestState } from '../ui/chat-state.js';
import { renderOutputText } from './output.js';

interface TaskState {
  id: string;
  description: string;
  agentType: string;
  status: 'initializing' | 'running' | 'completed' | 'failed' | 'skipped';
  toolCalls: Array<{ name: string; input: unknown }>;
  output?: string;
  error?: string;
  headerPrinted: boolean;
  startedLogged: boolean;
  origin?: string;
  outputArtifact?: string;
  model?: string;
  usage?: { total_tokens?: number; input_tokens?: number; output_tokens?: number; model?: string };
  outputLineCount?: number;
  outputWordCount?: number;
}

interface TaskStartedData {
  description: string;
  display_description?: string;
  agent_type?: string;
  task_type?: string;
  origin?: string;
  output_artifact?: string;
  model?: string;
}

interface TaskCompletedData {
  output_preview?: string;
  usage?: { total_tokens?: number; input_tokens?: number; output_tokens?: number; model?: string };
  output_line_count?: number;
  output_word_count?: number;
}

const AGENT_COLORS = {
  research: chalk.blue,
  analyze: chalk.magenta,
  write: chalk.green,
  code: chalk.hex('#FF6B35'),
  file: chalk.gray,
};

const STATUS_ICONS = {
  initializing: chalk.gray('□'),
  running: chalk.yellow('◐'),
  completed: chalk.green('■'),
  failed: chalk.red('✗'),
  skipped: chalk.gray('□'),
};

const TREE_BRANCH = '└';
const INDENT = '  ';

const truncateDescription = (desc: string, maxLength: number = 80): string => {
  if (desc.length <= maxLength) return desc;
  return `${desc.substring(0, maxLength - 3)}...`;
};

const formatTokenCount = (totalTokens?: number): string => {
  if (!totalTokens || totalTokens <= 0) return '0 tokens';
  if (totalTokens >= 1_000_000) return `${(totalTokens / 1_000_000).toFixed(1)}M tokens`;
  if (totalTokens >= 1_000) return `${(totalTokens / 1_000).toFixed(totalTokens >= 10_000 ? 0 : 1)}k tokens`;
  return `${totalTokens} tokens`;
};

class ConsoleWorkflowRenderer {
  private readonly tasks = new Map<string, TaskState>();
  private readonly toolResultByTask = new Map<string, number>();
  private lastRenderedThinking: string | null = null;
  private lastUpdateTodosHeader = '';
  private isFirstOutput = true;

  onEvent(event: WorkflowEvent): { output?: string; credits?: number; error?: string } | null {
    switch (event.type) {
      case 'tasks_initialized':
        return this.onTasksInitialized(event.data as { tasks: WorkflowTaskPlanEntry[] });
      case 'orchestrator_thinking':
        return this.onThinking(event.data as OrchestratorThinkingData);
      case 'task_started':
        return this.onTaskStarted(event);
      case 'subagent_tool_call':
        return this.onSubagentToolCall(event);
      case 'subagent_tool_result':
        return this.onSubagentToolResult(event);
      case 'task_added':
        return this.onTaskAdded(event);
      case 'task_reused':
        return this.onTaskReused(event);
      case 'task_skipped':
        return this.onTaskSkipped(event);
      case 'task_completed':
        return this.onTaskCompleted(event);
      case 'task_failed':
        return this.onTaskFailed(event);
      case 'workflow_completed':
        return this.onWorkflowCompleted(event.data as { output?: string; total_credits?: number });
      case 'workflow_failed':
        return this.onWorkflowFailed(event.data as { error?: string });
      case 'workflow_cancelled': {
        const cancelled = event.data as { reason?: string };
        return this.onWorkflowFailed({ error: cancelled.reason ?? 'Workflow cancelled' });
      }
      default:
        return null;
    }
  }

  private printTodosHeader(status: 'initial' | 'running' | 'completed' | 'failed'): void {
    const header = `${status}-todos`;
    if (this.lastUpdateTodosHeader === header) return;
    this.lastUpdateTodosHeader = header;

    const icon =
      status === 'running'
        ? chalk.yellow('◐')
        : status === 'completed'
          ? chalk.green('●')
          : status === 'failed'
            ? chalk.red('●')
            : chalk.green('●');

    console.log(`${icon} Update Todos`);
  }

  private renderTaskHeader(task: TaskState): void {
    if (task.headerPrinted) return;
    task.headerPrinted = true;

    const color = AGENT_COLORS[task.agentType as keyof typeof AGENT_COLORS] || chalk.white;
    const checkbox = STATUS_ICONS[task.status];
    const text =
      task.status === 'running'
        ? color(truncateDescription(task.description))
        : chalk.white(truncateDescription(task.description));

    console.log(`${INDENT}${TREE_BRANCH} ${checkbox} ${text}`);
  }

  private renderTaskStarted(task: TaskState): void {
    if (task.startedLogged) return;
    task.startedLogged = true;

    const extras: string[] = [];
    if (task.model) extras.push(chalk.dim(task.model));
    if (task.origin) extras.push(chalk.dim(task.origin));
    if (task.outputArtifact) extras.push(chalk.dim(task.outputArtifact));
    if (extras.length > 0) {
      console.log(`${INDENT}${INDENT}${chalk.gray('→')} ${extras.join(chalk.gray(' · '))}`);
    }
  }

  private renderToolCall(task: TaskState, toolCall: { name: string; input: unknown }): void {
    const input = toolCall.input as Record<string, unknown>;
    const detail = input.query ?? input.url ?? input.command ?? input.path ?? `${toolCall.name}(...)`;
    console.log(`${INDENT}${INDENT}${chalk.gray('•')} ${chalk.dim(String(detail))}`);
  }

  private renderTaskCompleted(task: TaskState): void {
    console.log(
      `${INDENT}${TREE_BRANCH} ${STATUS_ICONS.completed} ${chalk.white(truncateDescription(task.description))}`
    );

    const parts: string[] = [];
    const toolUseCount = this.toolResultByTask.get(task.id) ?? task.toolCalls.length;
    if (toolUseCount > 0) parts.push(chalk.gray(`${toolUseCount} tool ${toolUseCount === 1 ? 'use' : 'uses'}`));
    if (task.usage?.total_tokens) parts.push(chalk.gray(formatTokenCount(task.usage.total_tokens)));
    if (task.outputLineCount && task.agentType === 'write') parts.push(chalk.gray(`${task.outputLineCount} lines`));
    if (task.outputWordCount && task.agentType !== 'write') parts.push(chalk.gray(`${task.outputWordCount} words`));
    if (parts.length > 0) {
      console.log(`${INDENT}${INDENT}${chalk.gray('✓')} ${parts.join(chalk.gray(' · '))}`);
    }
  }

  private upsertTask(
    taskId: string,
    data: Partial<TaskState> & Pick<TaskState, 'description' | 'agentType' | 'status'>
  ): TaskState {
    const existing = this.tasks.get(taskId);
    const next: TaskState = existing ?? {
      id: taskId,
      description: data.description,
      agentType: data.agentType,
      status: data.status,
      toolCalls: [],
      headerPrinted: false,
      startedLogged: false,
    };

    Object.assign(next, data);
    this.tasks.set(taskId, next);
    return next;
  }

  private onTasksInitialized(data: { tasks: WorkflowTaskPlanEntry[] }) {
    this.printTodosHeader('initial');
    for (const task of data.tasks) {
      this.upsertTask(task.id, {
        description: task.description,
        agentType: task.agent_type,
        status: 'initializing',
        origin: task.origin ?? undefined,
        outputArtifact: task.output_artifact ?? undefined,
      });
      console.log(
        `${INDENT}${TREE_BRANCH} ${STATUS_ICONS.initializing} ${chalk.white(truncateDescription(task.description))}`
      );
    }
    console.log('');
    return null;
  }

  private onThinking(data: OrchestratorThinkingData) {
    if (this.lastRenderedThinking === data.thinking) return null;

    if (data.mode === 'stream' && this.lastRenderedThinking && data.thinking.startsWith(this.lastRenderedThinking)) {
      this.lastRenderedThinking = data.thinking;
      return null;
    }

    this.lastRenderedThinking = data.thinking;
    if (this.isFirstOutput) {
      console.log('');
      this.isFirstOutput = false;
    }
    console.log(`${chalk.white('●')} ${chalk.gray('(thinking)')} ${chalk.white(data.thinking.trim())}`);
    console.log('');
    return null;
  }

  private onTaskStarted(event: WorkflowEvent) {
    const data = event.data as TaskStartedData;
    const taskId = event.task_id ?? '';
    const task = this.upsertTask(taskId, {
      description: data.display_description || data.description,
      agentType: data.agent_type || data.task_type || 'task',
      status: 'running',
      origin: data.origin,
      outputArtifact: data.output_artifact,
      model: data.model,
    });

    this.printTodosHeader('running');
    this.renderTaskHeader(task);
    this.renderTaskStarted(task);
    return null;
  }

  private onSubagentToolCall(event: WorkflowEvent) {
    const taskId = event.task_id ?? '';
    const data = event.data as { tool_name: string; tool_input: unknown };
    const task = this.tasks.get(taskId);
    if (!task) return null;
    task.toolCalls.push({ name: data.tool_name, input: data.tool_input });
    this.renderToolCall(task, { name: data.tool_name, input: data.tool_input });
    return null;
  }

  private onSubagentToolResult(event: WorkflowEvent) {
    const taskId = event.task_id ?? '';
    if (taskId) {
      this.toolResultByTask.set(taskId, (this.toolResultByTask.get(taskId) ?? 0) + 1);
    }
    return null;
  }

  private onTaskAdded(event: WorkflowEvent) {
    const data = event.data as { description: string; agent_type: string; origin?: string; output_artifact?: string };
    this.upsertTask(event.task_id ?? '', {
      description: data.description,
      agentType: data.agent_type,
      status: 'initializing',
      origin: data.origin,
      outputArtifact: data.output_artifact,
    });
    return null;
  }

  private onTaskReused(event: WorkflowEvent) {
    const task = event.task_id ? this.tasks.get(event.task_id) : undefined;
    if (!task) return null;
    const data = event.data as { reason?: string; origin?: string };
    this.printTodosHeader('completed');
    console.log(
      `${INDENT}${TREE_BRANCH} ${STATUS_ICONS.completed} ${chalk.white(truncateDescription(task.description))}`
    );
    console.log(
      `${INDENT}${INDENT}${chalk.gray('→')} ${chalk.gray(`reused${data.reason ? ` · ${data.reason}` : ''}`)}`
    );
    task.origin = data.origin ?? task.origin;
    return null;
  }

  private onTaskSkipped(event: WorkflowEvent) {
    const task = event.task_id ? this.tasks.get(event.task_id) : undefined;
    if (task) task.status = 'skipped';
    return null;
  }

  private onTaskCompleted(event: WorkflowEvent) {
    const task = event.task_id ? this.tasks.get(event.task_id) : undefined;
    if (!task) return null;
    const data = event.data as TaskCompletedData;
    task.status = 'completed';
    task.output = data.output_preview;
    task.usage = data.usage;
    task.outputLineCount = data.output_line_count;
    task.outputWordCount = data.output_word_count;
    this.printTodosHeader('completed');
    this.renderTaskCompleted(task);
    return null;
  }

  private onTaskFailed(event: WorkflowEvent) {
    const task = event.task_id ? this.tasks.get(event.task_id) : undefined;
    if (!task) return null;
    const data = event.data as { error?: string };
    task.status = 'failed';
    task.error = data.error;
    this.printTodosHeader('failed');
    console.log(`${INDENT}${TREE_BRANCH} ${STATUS_ICONS.failed} ${chalk.red(truncateDescription(task.description))}`);
    if (data.error) {
      console.log(`${INDENT}${INDENT}${chalk.gray('→')} ${chalk.red(data.error)}`);
    }
    return null;
  }

  private onWorkflowCompleted(data: { output?: string; total_credits?: number }) {
    console.log('');
    console.log(chalk.bold('═'.repeat(60)));
    console.log(chalk.green.bold('✓ WORKFLOW COMPLETED'));
    console.log(chalk.bold('═'.repeat(60)));
    console.log('');
    renderOutputText(data.output || 'No output');
    console.log('');
    console.log(chalk.dim(`Credits used: ${data.total_credits?.toFixed(4) || '0'}`));
    console.log('');
    return { output: data.output, credits: data.total_credits };
  }

  private onWorkflowFailed(data: { error?: string }) {
    console.log('');
    console.log(chalk.bold('═'.repeat(60)));
    console.log(chalk.red.bold('✗ WORKFLOW FAILED'));
    console.log(chalk.bold('═'.repeat(60)));
    console.log('');
    console.log(chalk.red(data.error || 'Unknown error'));
    console.log('');
    return { error: data.error };
  }
}

export const streamWorkflow = async (
  workflowId: string,
  chatScreen?: ChatScreen,
  onApprovalRequest?: (request: ApprovalRequestState) => Promise<void>
): Promise<{ output?: string; credits?: number; error?: string; clarification?: ClarificationRequestState }> => {
  if (chatScreen) {
    let result: { output?: string; credits?: number; error?: string; clarification?: ClarificationRequestState } = {};
    let pendingClarification: ClarificationRequestState | undefined;
    const stream = executeWorkflow(workflowId);

    for await (const event of stream) {
      switch (event.type) {
        case 'orchestrator_thinking': {
          const data = event.data as OrchestratorThinkingData;
          chatScreen.appendAssistantThinking(data.thinking);
          chatScreen.setStatusMessage('thinking');
          break;
        }
        case 'tool_call': {
          const data = event.data as { tool_name: string; tool_input: unknown };
          if (data.tool_name === 'spawn_subagent') {
            break;
          }
          chatScreen.stopAssistantThinking();
          chatScreen.appendToolCall(data.tool_name, data.tool_input, 'orchestrator');
          break;
        }
        case 'tool_result': {
          const data = event.data as { tool_name: string; tool_output: unknown };
          if (data.tool_name === 'spawn_subagent') {
            break;
          }
          chatScreen.completeToolCall(data.tool_name, data.tool_output, 'orchestrator');
          break;
        }
        case 'subagent_tool_result': {
          const data = event.data as { tool_name: string; tool_output: unknown };
          chatScreen.completeToolCall(data.tool_name, data.tool_output, 'subagent');
          break;
        }
        case 'subagent_tool_call': {
          const data = event.data as { tool_name: string; tool_input: unknown };
          chatScreen.appendToolCall(data.tool_name, data.tool_input, 'subagent');
          break;
        }
        case 'task_started': {
          const data = event.data as {
            description: string;
            display_description?: string;
            task_type?: string;
            agent_type?: string;
            model?: string;
          };
          if (event.task_id) {
            chatScreen.beginSubagentWithDescription(
              event.task_id,
              data.agent_type || data.task_type || 'task',
              data.display_description || data.description,
              data.description,
              data.model
            );
          }
          break;
        }
        case 'task_completed': {
          const data = event.data as TaskCompletedData;
          chatScreen.addUsageTokens(data.usage?.total_tokens);
          if (event.task_id) {
            chatScreen.completeSubagent(event.task_id, data.usage?.total_tokens);
          }
          break;
        }
        case 'task_failed': {
          const data = event.data as { error?: string };
          if (event.task_id) {
            chatScreen.failSubagent(event.task_id, data.error);
          }
          break;
        }
        case 'bash_approval_requested': {
          const data = event.data as {
            id: string;
            command: string;
            reason: string;
          };
          if (onApprovalRequest) {
            await onApprovalRequest({
              id: data.id,
              title: 'Bash command approval required',
              subtitle: data.reason,
              command: data.command,
            });
          }
          break;
        }
        case 'clarification_requested': {
          const data = event.data as {
            question: string;
            options?: Array<{ label: string; description?: string }>;
            allow_custom?: boolean;
          };
          chatScreen.stopAssistantThinking();
          chatScreen.setStatusMessage('');
          pendingClarification = {
            question: data.question,
            options: data.options,
            allowCustom: data.allow_custom !== false,
          };
          break;
        }
        case 'workflow_completed': {
          const data = event.data as { output?: string; total_credits?: number };
          chatScreen.stopAssistantThinking();
          chatScreen.setStatusMessage('');
          chatScreen.completeAssistantTurn(data.output || 'No output', data.total_credits);
          result = { output: data.output, credits: data.total_credits };
          break;
        }
        case 'workflow_failed': {
          const data = event.data as { error?: string };
          chatScreen.stopAssistantThinking();
          chatScreen.setStatusMessage('');
          chatScreen.failAssistantTurn(data.error || 'Unknown error');
          result = { error: data.error };
          break;
        }
        case 'workflow_cancelled': {
          const data = event.data as { reason?: string };
          chatScreen.stopAssistantThinking();
          chatScreen.setStatusMessage('');
          chatScreen.failAssistantTurn(data.reason || 'Workflow cancelled');
          result = { error: data.reason };
          break;
        }
        default:
          break;
      }
    }

    try {
      await stream.done;
    } catch (error) {
      if (!result.error) {
        throw error;
      }
      result = { ...result, error: result.error ?? getErrorMessage(error) };
    }

    // If the workflow paused for clarification and no terminal event was emitted,
    // surface the clarification request to the caller so the user can respond.
    if (pendingClarification && !result.output && !result.error) {
      result.clarification = pendingClarification;
    }

    return result;
  }

  const renderer = new ConsoleWorkflowRenderer();
  let result: { output?: string; credits?: number; error?: string } = {};
  const stream = executeWorkflow(workflowId);
  for await (const event of stream) {
    const next = renderer.onEvent(event);
    if (next) result = next;
  }
  try {
    await stream.done;
  } catch (error) {
    if (!result.error) {
      throw error;
    }
    result = { ...result, error: result.error ?? getErrorMessage(error) };
  }
  return result;
};
