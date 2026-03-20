import { debitCredits } from '@orchestrator/billing';
import { computeCost, resolveOrchestratorModel, routeStreamingRequest } from '@orchestrator/model-router';
import {
  DEFAULT_TEMPERATURE,
  ORCHESTRATOR_MAX_OUTPUT_TOKENS,
  WorkflowError,
  getErrorMessage,
  logger,
} from '@orchestrator/shared';
import type { OutputBlock, WorkflowConfig } from '@orchestrator/shared';
import { formatConversationHistory, getPromptRuntimeContext, loadPrompt } from '../promptLoader.js';
import { getWorkItemDisplayId, listWorkItems } from '../workItems.js';
import { completeWorkflow, failWorkflow } from '../subagents/lifecycle.js';
import { executeOrchestratorToolCall } from './toolExecutor.js';
import { buildToolTraceHooks, recordStep } from './tracing.js';
import { extractToolCallsFromOutput, normalizeToolCall, ORCHESTRATOR_TOOLS, type ToolCall } from './tools.js';
import { emitWorkflowEvent } from '../workflow/emitter.js';
import {
  createWorkflowState,
  MAX_TURNS,
  type WorkflowState,
  type WorkflowStatus,
  workflows,
} from '../workflow/state.js';
import { hydrateWorkflowState, incrementWorkflowCredits, insertWorkflow } from '../workflow/persistence.js';

const buildTodoContext = (state: WorkflowState): string => {
  const todos = listWorkItems(state.id);
  if (todos.length === 0) {
    return 'No todos yet.';
  }

  return `Current todos:\n${todos
    .map(
      (todo) =>
        `- ${getWorkItemDisplayId(state.id, todo.id)}: [${todo.status}] ${todo.description} (${todo.agentType})${
          todo.dependsOn.length > 0
            ? ` (depends on: ${todo.dependsOn.map((depId) => getWorkItemDisplayId(state.id, depId)).join(', ')})`
            : ''
        }`
    )
    .join('\n')}`;
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

export const callOrchestrator = async (
  state: WorkflowState,
  iteration: number
): Promise<{ toolCalls: ToolCall[]; responseText: string; rawOutput: OutputBlock[] }> => {
  const runtimeContext = getPromptRuntimeContext();
  const instructions = loadPrompt('orchestrator.md', {
    todoContext: buildTodoContext(state),
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
      rawOutput.push({ type: 'tool_use', ...(chunk.data as Record<string, unknown>) });
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
        try {
          debitCredits(
            state.userId,
            usageCost.total_cost,
            `Orchestrator iteration ${iteration}: ${state.id}`,
            'workflow',
            state.id
          );
          incrementWorkflowCredits(state, usageCost.total_cost);
        } catch (err) {
          logger.warn(
            { workflowId: state.id, iteration, error: getErrorMessage(err) },
            'Failed to debit credits for orchestrator iteration (non-critical)'
          );
        }
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
  const orchestratorModel = resolveOrchestratorModel(config.orchestrator_model ?? config.model_overrides?.orchestrator);

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

  try {
    for (let iteration = 1; iteration <= MAX_TURNS; iteration++) {
      if (state.abortController.signal.aborted) {
        throw new WorkflowError('Workflow cancelled');
      }

      const { toolCalls, responseText } = await callOrchestrator(state, iteration);

      state.messages.push({ role: 'assistant', content: responseText });
      state.conversationHistory.push({
        role: 'assistant',
        content: responseText,
        timestamp: new Date().toISOString(),
      });

      if (toolCalls.length === 0) {
        completeWorkflow(state, responseText);
        return { workflowId: id, output: responseText, status: 'completed' };
      }

      const toolResults: Array<Record<string, unknown>> = [];
      let explicitOutput: string | null = null;

      for (const call of toolCalls) {
        const result = await executeOrchestratorToolCall(state, call);
        toolResults.push({ tool: call.name, ...result });

        if (typeof result.workflow_output === 'string' && result.workflow_output.length > 0) {
          explicitOutput = result.workflow_output;
        }
      }

      if (explicitOutput) {
        completeWorkflow(state, explicitOutput);
        return { workflowId: id, output: explicitOutput, status: 'completed' };
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
