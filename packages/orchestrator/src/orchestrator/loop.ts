import { debitCredits } from '@orchestrator/billing';
import { recallMemory } from '@orchestrator/memory';
import {
  computeCost,
  getAllSkillsForUser,
  getOpenTerminalSessionForChat,
  resolveOrchestratorModel,
  routeStreamingRequest,
} from '@orchestrator/model-router';
import {
  DEFAULT_TEMPERATURE,
  ORCHESTRATOR_MAX_OUTPUT_TOKENS,
  WorkflowError,
  getErrorMessage,
  logger,
} from '@orchestrator/shared';
import type { OutputBlock, WorkflowConfig } from '@orchestrator/shared';
import { formatConversationHistory, getPromptRuntimeContext, loadPrompt } from '../promptLoader.js';
import { formatWorkItemsForPrompt, isWorkItemSettled, listWorkItems } from '../workItems.js';
import { completeWorkflow, failWorkflow } from '../subagents/lifecycle.js';
import { executeOrchestratorToolCall } from './toolExecutor.js';
import { buildToolTraceHooks, recordStep } from './tracing.js';
import { extractToolCallsFromOutput, normalizeToolCall, ORCHESTRATOR_TOOLS, type ToolCall } from './tools.js';
import { emitWorkflowEvent } from '../workflow/emitter.js';
import { waitForRuns } from '../subagents/runner.js';
import {
  createWorkflowState,
  MAX_TURNS,
  type WorkflowState,
  type WorkflowStatus,
  workflows,
} from '../workflow/state.js';
import { hydrateWorkflowState, incrementWorkflowCredits, insertWorkflow, persistWorkflowStatus } from '../workflow/persistence.js';
import { ensureEnvironmentSession } from '../agents.js';

const ensureWorkflowEnvironmentReady = async (state: WorkflowState): Promise<void> => {
  const chatId = state.config.chat_id ?? state.id;
  const existing = await getOpenTerminalSessionForChat(state.userId, chatId);

  emitWorkflowEvent(state, {
    type: 'tool_call',
    workflow_id: state.id,
    data: {
      tool_name: 'start_environment',
      tool_input: {
        chat_id: chatId,
        mode: existing ? 'reuse' : 'create',
      },
    },
  });

  if (!existing) {
    await ensureEnvironmentSession(
      {
        workflowId: state.id,
        userId: state.userId,
        orchestratorModel: state.orchestratorModel,
        config: state.config,
        sandboxSessionIds: state.sandboxSessionIds,
        abortSignal: state.abortController.signal,
        creditsCallback: () => undefined,
        trace: buildToolTraceHooks(state, 'orchestrator', state.orchestratorModel),
      },
      undefined
    );
  }

  const ready = await getOpenTerminalSessionForChat(state.userId, chatId);
  emitWorkflowEvent(state, {
    type: 'tool_result',
    workflow_id: state.id,
    data: {
      tool_name: 'start_environment',
      tool_output: {
        status: 'ready',
        chat_id: chatId,
        open_terminal_url: ready?.baseUrl ?? null,
      },
    },
  });
};

const parseStructuredOutputText = (
  text: string
): { thinking?: string; toolCalls: ToolCall[]; finalText?: string } | null => {
  try {
    const parsed = JSON.parse(text) as {
      thinking?: unknown;
      tool_calls?: Array<{ name?: unknown; arguments?: unknown }>;
      answer?: unknown;
      output?: unknown;
    };

    const toolCalls = Array.isArray(parsed.tool_calls)
      ? parsed.tool_calls
          .filter((call): call is { name: string; arguments?: unknown } => typeof call?.name === 'string')
          .map((call) => ({
            name: call.name,
            arguments:
              call.arguments && typeof call.arguments === 'object' && !Array.isArray(call.arguments)
                ? (call.arguments as Record<string, unknown>)
                : {},
          }))
      : [];

    const finalText =
      typeof parsed.answer === 'string' ? parsed.answer : typeof parsed.output === 'string' ? parsed.output : undefined;

    return {
      thinking: typeof parsed.thinking === 'string' ? parsed.thinking : undefined,
      toolCalls,
      finalText,
    };
  } catch {
    return null;
  }
};

const toToolUseBlock = (data: unknown): OutputBlock | null => {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;

  const name = typeof record.name === 'string' ? record.name : null;
  if (!name) return null;

  const rawArgs = record.arguments;
  const argsIsObject = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs);
  if (typeof rawArgs !== 'string' && !argsIsObject) return null;

  return {
    type: 'tool_use',
    id: typeof record.id === 'string' ? record.id : undefined,
    name,
    arguments: (argsIsObject ? (rawArgs as Record<string, unknown>) : rawArgs) as string | Record<string, unknown>,
  };
};

const pushUserMessage = (state: WorkflowState, content: string): void => {
  const last = state.messages[state.messages.length - 1];
  if (last?.role === 'user' && last.content === content) {
    return;
  }

  state.messages.push({ role: 'user', content });
  state.conversationHistory.push({
    role: 'user',
    content,
    timestamp: new Date().toISOString(),
  });
};

const ensureWorkflowCanComplete = async (
  state: WorkflowState,
  candidateOutput: string,
  iteration: number
): Promise<boolean> => {
  const runningTodoIds = Array.from(state.subagentRuns.values())
    .filter((run) => run.status === 'running')
    .map((run) => run.workItemId);

  if (runningTodoIds.length > 0) {
    await waitForRuns(state, runningTodoIds, 5);
  }

  const unsettled = listWorkItems(state.id).filter((item) => !isWorkItemSettled(item.status));
  if (unsettled.length === 0) {
    return true;
  }

  const summary = unsettled.map((item) => {
    const todoId = item.id.replace(`${state.id}_`, '');
    return `${todoId} [${item.status}] - ${item.description}`;
  });

  const guardMessage =
    'Workflow completion blocked: unresolved tasks remain.\n' +
    summary.map((line) => `- ${line}`).join('\n') +
    '\nResolve these tasks first using spawn_subagent/await_subagents/edit_todo, then return the final answer.';

  pushUserMessage(state, guardMessage);

  logger.warn(
    {
      workflowId: state.id,
      iteration,
      unresolvedTaskCount: unsettled.length,
      runningSubagents: runningTodoIds.length,
      blockedOutputPreview: candidateOutput.slice(0, 200),
    },
    'Prevented premature workflow completion while tasks were unresolved'
  );

  return false;
};

export const callOrchestrator = async (
  state: WorkflowState,
  iteration: number
): Promise<{ toolCalls: ToolCall[]; responseText: string; rawOutput: OutputBlock[] }> => {
  const runtimeContext = getPromptRuntimeContext();
  const workItems = listWorkItems(state.id);
  const instructions = loadPrompt('orchestrator.md', {
    todoContext: workItems.length === 0 ? 'No todos yet.' : formatWorkItemsForPrompt(workItems),
    conversationHistory: formatConversationHistory(state.conversationHistory),
    currentDate: runtimeContext.currentDate,
    currentTime: runtimeContext.currentTime,
    currentDateTime: runtimeContext.currentDateTime,
    currentTimezone: runtimeContext.currentTimezone,
    nowIso: runtimeContext.nowIso,
    modelBackend: runtimeContext.modelBackend,
  });

  const rawOutput: OutputBlock[] = [];
  const textParts: string[] = [];
  const reasoningParts: string[] = [];

  for await (const chunk of routeStreamingRequest({
    model: state.orchestratorModel,
    input: state.messages.map((message) => ({ ...message })),
    instructions,
    tools: ORCHESTRATOR_TOOLS,
    tool_execution: 'manual',
    max_output_tokens: ORCHESTRATOR_MAX_OUTPUT_TOKENS,
    temperature: DEFAULT_TEMPERATURE,
    trace: buildToolTraceHooks(state, 'orchestrator', state.orchestratorModel),
    signal: state.abortController.signal,
    stream: true,
  })) {
    if (chunk.type === 'reasoning_delta' && chunk.text) {
      reasoningParts.push(chunk.text);
      emitWorkflowEvent(state, {
        type: 'orchestrator_thinking',
        workflow_id: state.id,
        data: {
          thinking: reasoningParts.join(''),
          iteration,
          mode: 'stream',
        },
      });
      continue;
    }

    if (chunk.type === 'text_delta' && chunk.text) {
      textParts.push(chunk.text);
      continue;
    }

    if (chunk.type === 'tool_use' && chunk.data && typeof chunk.data === 'object') {
      const block = toToolUseBlock(chunk.data);
      if (block) {
        rawOutput.push(block);
      }
      continue;
    }

    if (chunk.type === 'usage' && chunk.data && typeof chunk.data === 'object') {
      const usage = chunk.data as {
        prompt_tokens?: number;
        completion_tokens?: number;
      };
      const usageCost =
        usage.prompt_tokens || usage.completion_tokens
          ? computeCost(state.orchestratorModel, usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0)
          : null;

      if (usageCost && usageCost.total_cost > 0) {
        debitCredits(
          state.userId,
          usageCost.total_cost,
          `Orchestrator iteration ${iteration}: ${state.id}`,
          'workflow',
          state.id
        ).then(() => {
          incrementWorkflowCredits(state, usageCost.total_cost);
        }).catch((err: unknown) => {
          logger.warn(
            { workflowId: state.id, iteration, error: getErrorMessage(err) },
            'Failed to debit credits for orchestrator iteration (non-critical)'
          );
        });
      }
      continue;
    }

    if (chunk.type === 'error') {
      const message =
        chunk.data && typeof chunk.data === 'object' && 'message' in chunk.data
          ? String((chunk.data as { message?: unknown }).message ?? 'Model streaming failed')
          : 'Model streaming failed';
      throw new WorkflowError(message);
    }
  }

  const reasoningText = reasoningParts.join('');
  let responseText = textParts.join('');
  let toolCalls = extractToolCallsFromOutput(rawOutput).map(normalizeToolCall);

  if (reasoningText) {
    rawOutput.push({ type: 'reasoning', content: reasoningText });
  }

  const parsedText = parseStructuredOutputText(responseText);
  if (parsedText?.thinking && !reasoningText) {
    emitWorkflowEvent(state, {
      type: 'orchestrator_thinking',
      workflow_id: state.id,
      data: {
        thinking: parsedText.thinking,
        iteration,
        mode: 'response',
      },
    });
  }

  if (toolCalls.length === 0 && parsedText && parsedText.toolCalls.length > 0) {
    toolCalls = parsedText.toolCalls.map(normalizeToolCall);
  }

  if (toolCalls.length === 0 && parsedText?.finalText) {
    responseText = parsedText.finalText;
  }

  if (!rawOutput.some((block) => block.type === 'message') && responseText) {
    rawOutput.push({ type: 'message', content: responseText });
  }

  if (parsedText?.thinking && !reasoningText) {
    rawOutput.push({ type: 'reasoning', content: parsedText.thinking });
  }

  recordStep(state, {
    step_type: 'orchestrator_message',
    model_name: state.orchestratorModel,
    message_content: responseText.substring(0, 1000),
    tool_name: null,
    tool_input: { iteration, streamed: true },
    tool_output: null,
    subagent_id: 'orchestrator',
  });

  return {
    toolCalls,
    responseText,
    rawOutput,
  };
};

export const runWorkflow = async (
  userId: string,
  config: WorkflowConfig,
  workflowId?: string
): Promise<{ workflowId: string; output: string; status: WorkflowStatus }> => {
  const isContinuing = !!workflowId && workflows.has(workflowId);
  const id = workflowId ?? crypto.randomUUID();
  const orchestratorModel = resolveOrchestratorModel(config.orchestrator_model ?? config.model_overrides?.orchestrator, userId);

  let state: WorkflowState;

  if (isContinuing) {
    state = workflows.get(id)!;
    state.abortController = new AbortController();

    if (state.status !== 'executing') {
      throw new WorkflowError(`Cannot run workflow in status: ${state.status}`);
    }
  } else {
    const hydrated = hydrateWorkflowState(id);
    if (hydrated) {
      state = hydrated;
      state.abortController = new AbortController();
      if (state.status !== 'executing') {
        throw new WorkflowError(`Cannot run workflow in status: ${state.status}`);
      }
    } else {
      insertWorkflow(id, userId, config, orchestratorModel);
      state = createWorkflowState({
        id,
        userId,
        config,
        orchestratorModel,
        status: 'executing',
      });
      workflows.set(id, state);
    }
  }

  // Inject relevant memories from past sessions
  try {
    const memories = recallMemory(userId, config.objective, 10);
    if (memories.length > 0) {
      const memoryLines = memories.map((m) => `- [${m.category}/${m.key}]: ${m.content}`).join('\n');
      const memoryContext = `\n\n## Relevant Memory from Past Sessions\n${memoryLines}\n`;
      const trimmed = memoryContext.length > 2000 ? memoryContext.substring(0, 2000) + '...' : memoryContext;
      state.messages.unshift({ role: 'system', content: trimmed });
    }
  } catch (err) {
    logger.warn({ workflowId: id, error: getErrorMessage(err) }, 'Failed to recall memories (non-critical)');
  }

  // Inject context_files — decode base64 files and attach as context
  if (!isContinuing && config.context_files && config.context_files.length > 0) {
    try {
      const fileTexts = config.context_files.flatMap((f) => {
        try {
          const content = Buffer.from(f.content_base64, 'base64').toString('utf-8');
          // Only inject text-like files; skip binary content
          if (/[\x00-\x08\x0e-\x1f]/.test(content.substring(0, 100))) return [];
          const truncated = content.length > 8000 ? content.substring(0, 8000) + '\n...[truncated]' : content;
          return [`\n### File: ${f.filename}\n\`\`\`\n${truncated}\n\`\`\``];
        } catch {
          return [];
        }
      });
      if (fileTexts.length > 0) {
        const contextMsg = `## Context Files\nThe following files have been provided as context:\n${fileTexts.join('\n')}`;
        state.messages.unshift({ role: 'system', content: contextMsg });
      }
    } catch (err) {
      logger.warn({ workflowId: id, error: getErrorMessage(err) }, 'Failed to inject context_files (non-critical)');
    }
  }

  // Inject user-defined skills as available tool context
  try {
    const userSkills = getAllSkillsForUser(userId);
    if (userSkills.length > 0) {
      const skillLines = userSkills
        .map((s) => {
          const desc = s.description ?? '';
          const shortDesc = desc.length > 60 ? desc.slice(0, 57) + '...' : desc;
          return `- **${s.id}**: ${shortDesc || '(no description)'} → call \`run_skill\` to activate`;
        })
        .join('\n');
      const skillContext = `\n\n## Your Custom Skills\nThe following user-defined skills are available. When a skill is relevant, you MUST call the \`run_skill\` tool with the skill id to activate it and receive full instructions. Do not attempt to execute skill logic without calling the tool.\n\n${skillLines}\n`;
      state.messages.unshift({ role: 'system', content: skillContext });
    }
  } catch (err) {
    logger.warn({ workflowId: id, error: getErrorMessage(err) }, 'Failed to inject skills (non-critical)');
  }

  try {
    await ensureWorkflowEnvironmentReady(state);

    for (let iteration = 1; iteration <= MAX_TURNS; iteration++) {
      if (state.abortController.signal.aborted) {
        throw new WorkflowError('Workflow cancelled');
      }

      // Emit a progress event every 5 iterations for long-running job observability
      if (iteration > 1 && iteration % 5 === 1) {
        const completedTasks = listWorkItems(state.id).filter((item) => isWorkItemSettled(item.status)).length;
        const totalTasks = listWorkItems(state.id).length;
        emitWorkflowEvent(state, {
          type: 'workflow_progress',
          workflow_id: state.id,
          data: {
            iteration,
            max_turns: MAX_TURNS,
            completed_tasks: completedTasks,
            total_tasks: totalTasks,
            credits_consumed: state.creditsConsumed,
          },
        });
      }

      const { toolCalls, responseText } = await callOrchestrator(state, iteration);

      state.messages.push({ role: 'assistant', content: responseText });
      state.conversationHistory.push({
        role: 'assistant',
        content: responseText,
        timestamp: new Date().toISOString(),
      });

      if (toolCalls.length === 0) {
        // On the first iteration, detect if the model is asking for clarification without using the tool
        if (iteration === 1) {
          const lower = responseText.toLowerCase();
          const hasClarificationSignal =
            (lower.includes('clarif') || lower.includes('please specify') || lower.includes('could you') ||
             lower.includes('what would you') || lower.includes('what type') || lower.includes('which file') ||
             lower.includes('more context') || lower.includes('more information') || lower.includes('unclear')) &&
            responseText.includes('?');
          if (hasClarificationSignal) {
            emitWorkflowEvent(state, {
              type: 'clarification_requested',
              workflow_id: state.id,
              data: { question: responseText },
            });
            state.status = 'paused';
            persistWorkflowStatus(id, 'paused', responseText);
            return { workflowId: id, output: responseText, status: 'paused' };
          }
        }
        const canComplete = await ensureWorkflowCanComplete(state, responseText, iteration);
        if (canComplete) {
          completeWorkflow(state, responseText);
          return { workflowId: id, output: responseText, status: 'completed' };
        }
        continue;
      }

      const toolResults: Array<Record<string, unknown>> = [];
      let explicitOutput: string | null = null;
      let clarificationQuestion: string | null = null;

      for (const call of toolCalls) {
        const result = await executeOrchestratorToolCall(state, call);
        toolResults.push({ tool: call.name, ...result });

        if (typeof result.workflow_output === 'string' && result.workflow_output.length > 0) {
          explicitOutput = result.workflow_output;
        }

        if (result.pause_workflow === true && typeof result.clarification_question === 'string') {
          clarificationQuestion = result.clarification_question;
        }
      }

      if (clarificationQuestion) {
        state.status = 'paused';
        persistWorkflowStatus(id, 'paused', clarificationQuestion);
        return { workflowId: id, output: clarificationQuestion, status: 'paused' };
      }

      if (explicitOutput) {
        const canComplete = await ensureWorkflowCanComplete(state, explicitOutput, iteration);
        if (canComplete) {
          completeWorkflow(state, explicitOutput);
          return { workflowId: id, output: explicitOutput, status: 'completed' };
        }
      }

      const resultsMessage = `Tool results:\n${toolResults.map((result) => `- ${result.tool}: ${JSON.stringify(result)}`).join('\n')}`;
      state.messages.push({ role: 'user', content: resultsMessage });
    }

    await failWorkflow(state, `Workflow exceeded ${MAX_TURNS} turns`);
    return { workflowId: id, output: 'Workflow exceeded maximum turns', status: 'failed' };
  } catch (err) {
    const errorMessage = getErrorMessage(err, 'Workflow execution failed');
    await failWorkflow(state, errorMessage);
    throw err;
  }
};
