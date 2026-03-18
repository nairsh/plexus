/**
 * Specialized sub-agent system.
 *
 * Each AgentType has a dedicated system prompt, allowed tools, and preferred model.
 * The orchestrator dispatches tasks to these agents; they return their output as a string.
 */

import { routeRequest, getOpenTerminalSessionForChat, getAgentModel as getConfigAgentModel } from '@orchestrator/model-router';
import { debitCredits } from '@orchestrator/billing';
import { createSession, execute as sandboxExecute, terminateSession } from '@orchestrator/sandbox';
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  RESEARCH_TEMPERATURE,
  WRITE_TEMPERATURE,
  getErrorMessage,
  logger,
} from '@orchestrator/shared';
import type {
  AgentType,
  OrchestratorTask,
  WorkflowConfig,
  ToolTraceHooks,
  SubagentExecutionResult,
  Tool,
} from '@orchestrator/shared';
import { getPromptRuntimeContext, loadPrompt } from './promptLoader.js';

// ── Agent configuration ──

interface AgentConfig {
  /** Preferred model — falls back to orchestratorModel if not available */
  model: string;
  /** Tools this agent may use */
  tools: Tool[];
  /** Skills this agent may activate */
  skills: string[];
  /** Prompt template file */
  promptFile: string;
}

const AGENT_CONFIGS: Record<AgentType, AgentConfig> = {
  research: {
    model: 'litellm/gemini-3-flash-preview',
    tools: [{ type: 'web_search' }, { type: 'fetch_url' }, { type: 'run_skill' }],
    skills: [],
    promptFile: 'research.md',
  },

  analyze: {
    model: 'litellm/ali-kimi-k2.5',
    tools: [
      { type: 'bash' },
      { type: 'file_read' },
      { type: 'file_write' },
      { type: 'file_edit' },
      { type: 'grep' },
      { type: 'glob' },
      { type: 'run_skill' },
    ],
    skills: [],
    promptFile: 'analyze.md',
  },

  write: {
    model: 'litellm/ali-kimi-k2.5',
    tools: [
      { type: 'bash' },
      { type: 'file_read' },
      { type: 'file_write' },
      { type: 'file_edit' },
      { type: 'grep' },
      { type: 'glob' },
      { type: 'run_skill' },
    ],
    skills: [],
    promptFile: 'write.md',
  },

  code: {
    model: 'litellm/gemini-3-flash-preview',
    tools: [
      { type: 'bash' },
      { type: 'file_read' },
      { type: 'file_write' },
      { type: 'file_edit' },
      { type: 'grep' },
      { type: 'glob' },
      { type: 'run_skill' },
    ],
    skills: [],
    promptFile: 'code.md',
  },

  file: {
    model: 'litellm/gemini-3.1-flash-lite-preview',
    tools: [
      { type: 'bash' },
      { type: 'file_read' },
      { type: 'file_write' },
      { type: 'file_edit' },
      { type: 'grep' },
      { type: 'glob' },
      { type: 'run_skill' },
    ],
    skills: [],
    promptFile: 'file.md',
  },
};

const buildAgentInstructions = (agentType: AgentType): string => {
  const runtimeContext = getPromptRuntimeContext();
  const config = AGENT_CONFIGS[agentType];
  return loadPrompt(config.promptFile, {
    currentDate: runtimeContext.currentDate,
    currentTime: runtimeContext.currentTime,
    currentDateTime: runtimeContext.currentDateTime,
    currentTimezone: runtimeContext.currentTimezone,
    nowIso: runtimeContext.nowIso,
    modelBackend: runtimeContext.modelBackend,
    agentType,
  });
};

// ── Execution context passed from engine ──

export interface AgentExecutionContext {
  workflowId: string;
  userId: string;
  orchestratorModel: string;
  config: WorkflowConfig;
  sandboxSessionIds: string[];
  abortSignal: AbortSignal;
  creditsCallback: (amount: number, description: string) => void;
  trace: ToolTraceHooks;
}

// ── Main dispatch function ──

/**
 * Dispatch a task to its specialized sub-agent and return the output string.
 * Handles model selection, tool configuration, cost tracking, and sandbox sessions.
 */
export async function dispatchToAgent(
  task: OrchestratorTask,
  prompt: string,
  ctx: AgentExecutionContext
): Promise<SubagentExecutionResult> {
  const config = AGENT_CONFIGS[task.agent_type];
  // Use the getAgentModel function which checks config first, then falls back to hardcoded
  const model = getAgentModel(task.agent_type, ctx.config.model_overrides);

  // Dry-run mode: return mock result without calling LLM
  if (process.env.DRY_RUN === '1') {
    logger.info(
      { workflowId: ctx.workflowId, taskId: task.task_id, agentType: task.agent_type },
      '[DRY RUN] Skipping agent dispatch'
    );
    return {
      output: `[DRY RUN] ${task.agent_type} agent would process: ${task.description}`,
      model,
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
        cost: { currency: 'USD' as const, input_cost: 0, output_cost: 0, tool_calls_cost: 0, total_cost: 0 },
      },
    };
  }

  logger.info(
    { workflowId: ctx.workflowId, taskId: task.task_id, agentType: task.agent_type, model, promptLength: prompt.length },
    'Dispatching to sub-agent'
  );
  
  logger.debug(
    { workflowId: ctx.workflowId, taskId: task.task_id, promptPreview: prompt.substring(0, 200) },
    'Sub-agent prompt preview'
  );

  // Code and file agents may need a workspace session
  if (task.agent_type === 'code' || task.agent_type === 'file') {
    const chatId = ctx.config.chat_id ?? ctx.workflowId;
    await ensureWorkspaceSession(ctx, chatId, task.task_id);
  }

  const chatId = (task.agent_type === 'code' || task.agent_type === 'file')
    ? (ctx.config.chat_id ?? ctx.workflowId)
    : undefined;

  logger.debug(
    { workflowId: ctx.workflowId, taskId: task.task_id, model, hasTools: config.tools.length > 0 },
    'Calling routeRequest for sub-agent'
  );

  const response = await routeRequest({
    model,
    input: prompt,
    instructions: buildAgentInstructions(task.agent_type),
    tools: config.tools.length > 0 ? config.tools : undefined,
    allowed_skills: config.skills,
    max_output_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
    temperature: task.agent_type === 'write' ? WRITE_TEMPERATURE : RESEARCH_TEMPERATURE,
    trace: ctx.trace,
    chat_id: chatId,
    signal: ctx.abortSignal,
  });

  // Track cost
  if (response.usage.cost.total_cost > 0) {
    try {
      debitCredits(
        ctx.userId,
        response.usage.cost.total_cost,
        `Agent task: ${task.task_id} (${task.agent_type})`,
        'workflow',
        ctx.workflowId
      );
      ctx.creditsCallback(response.usage.cost.total_cost, task.task_id);
    } catch (err) {
      logger.warn({ workflowId: ctx.workflowId, taskId: task.task_id, error: getErrorMessage(err) }, 'Failed to debit credits for agent task (non-critical)');
    }
  }

  return {
    output: response.output_text,
    model: response.model,
    usage: response.usage,
  };
}

// ── Workspace session helper ──

async function ensureWorkspaceSession(
  ctx: AgentExecutionContext,
  chatId: string,
  taskId: string
): Promise<void> {
  const existing = await getOpenTerminalSessionForChat(chatId);
  if (existing) return;

  const session = await createSession(ctx.userId, {
    language: 'javascript',
    chat_id: chatId,
    task_id: taskId,
  });
  ctx.sandboxSessionIds.push(session.id);
}

// ── Expose agent config metadata ──

export function getAgentDisplayName(agentType: AgentType): string {
  const names: Record<AgentType, string> = {
    research: 'Research',
    analyze: 'Analysis',
    write: 'Writing',
    code: 'Code',
    file: 'File Ops',
  };
  return names[agentType] ?? agentType;
}

export function getAgentModel(agentType: AgentType, overrides?: Record<string, string>): string {
  // First check overrides (from workflow config)
  if (overrides?.[agentType]) {
    return overrides[agentType];
  }
  // Then check runtime config (from CLI onboarding)
  const configModel = getConfigAgentModel(agentType);
  if (configModel) {
    return configModel;
  }
  // Fall back to hardcoded default
  return AGENT_CONFIGS[agentType].model;
}

// Re-export sandbox utilities for cleanup
export { terminateSession };
