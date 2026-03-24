/**
 * Specialized sub-agent system.
 *
 * Each AgentType has a dedicated system prompt, allowed tools, and preferred model.
 * The orchestrator dispatches tasks to these agents; they return their output as a string.
 */

import { mkdirSync } from 'node:fs';
import {
  routeRequest,
  getOpenTerminalSessionForChat,
  getAgentModel as getConfigAgentModel,
  getAllSkillsForUser,
} from '@orchestrator/model-router';
import { debitCredits } from '@orchestrator/billing';
import { createSession, getSessionInfo, terminateSession } from '@orchestrator/sandbox';
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  RESEARCH_TEMPERATURE,
  WRITE_TEMPERATURE,
  getErrorMessage,
  getDb,
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
import { normalizeWorkingDirectory } from './folderScope.js';

// ── Agent health recording ──

function recordHealth(agentType: AgentType, model: string, success: boolean, latencyMs?: number): void {
  try {
    const db = getDb();
    if (success && latencyMs !== undefined) {
      db.prepare(`
        INSERT INTO agent_health (id, agent_type, model, status, last_success_at, success_count_1h, total_latency_ms_1h)
        VALUES (?, ?, ?, 'healthy', datetime('now'), 1, ?)
        ON CONFLICT(agent_type, model) DO UPDATE SET
          status = 'healthy',
          last_success_at = datetime('now'),
          success_count_1h = success_count_1h + 1,
          total_latency_ms_1h = total_latency_ms_1h + excluded.total_latency_ms_1h,
          updated_at = datetime('now')
      `).run(crypto.randomUUID(), agentType, model, latencyMs);
    } else if (!success) {
      db.prepare(`
        INSERT INTO agent_health (id, agent_type, model, status, last_failure_at, failure_count_1h)
        VALUES (?, ?, ?, 'degraded', datetime('now'), 1)
        ON CONFLICT(agent_type, model) DO UPDATE SET
          last_failure_at = datetime('now'),
          failure_count_1h = failure_count_1h + 1,
          status = CASE
            WHEN failure_count_1h + 1 >= 5 THEN 'unavailable'
            WHEN failure_count_1h + 1 >= 2 THEN 'degraded'
            ELSE 'healthy'
          END,
          updated_at = datetime('now')
      `).run(crypto.randomUUID(), agentType, model);
    }
  } catch {
    // Health recording is non-critical; never let it break agent dispatch
  }
}

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
    tools: [{ type: 'web_search' }, { type: 'fetch_url' }, { type: 'search_knowledge' }, { type: 'run_skill' }],
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
      { type: 'search_knowledge' },
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
      { type: 'search_knowledge' },
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
      { type: 'search_knowledge' },
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
      { type: 'search_knowledge' },
      { type: 'run_skill' },
    ],
    skills: [],
    promptFile: 'file.md',
  },

  deep_research: {
    model: 'litellm/gemini-3-flash-preview',
    tools: [{ type: 'web_search' }, { type: 'fetch_url' }, { type: 'search_knowledge' }, { type: 'run_skill' }],
    skills: [],
    promptFile: 'deep-research.md',
  },
};

const buildAgentInstructions = (agentType: AgentType, userId: string): string => {
  const runtimeContext = getPromptRuntimeContext();
  const config = AGENT_CONFIGS[agentType];
  const basePrompt = loadPrompt(config.promptFile, {
    currentDate: runtimeContext.currentDate,
    currentTime: runtimeContext.currentTime,
    currentDateTime: runtimeContext.currentDateTime,
    currentTimezone: runtimeContext.currentTimezone,
    nowIso: runtimeContext.nowIso,
    modelBackend: runtimeContext.modelBackend,
    agentType,
  });

  const skills = getAllSkillsForUser(userId);
  if (skills.length === 0) {
    return basePrompt;
  }

  const skillLines = skills.map((skill) => `- ${skill.id}: ${skill.description}`);
  return `${basePrompt}\n\nAvailable skills:\n${skillLines.join('\n')}\nUse run_skill with an exact skill_id when a skill materially improves task quality.`;
};

const workspaceBootstrapLocks = new Map<string, Promise<void>>();

const workspaceLockKey = (userId: string, chatId: string): string => `${userId}:${chatId}`;

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
  const model = getAgentModel(task.agent_type, ctx.config.model_overrides, ctx.userId);

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

  const chatId = ctx.config.chat_id ?? ctx.workflowId;
  const workingDirectory = normalizeWorkingDirectory(ctx.config.working_directory);

  const startMs = Date.now();
  let response: Awaited<ReturnType<typeof routeRequest>>;
  try {
    response = await routeRequest({
      model,
      input: prompt,
      instructions: buildAgentInstructions(task.agent_type, ctx.userId),
      tools: config.tools.length > 0 ? config.tools : undefined,
      allowed_skills: config.skills.length > 0 ? config.skills : undefined,
      max_output_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
      temperature: task.agent_type === 'write' ? WRITE_TEMPERATURE : RESEARCH_TEMPERATURE,
      trace: ctx.trace,
      chat_id: chatId,
      user_id: ctx.userId,
      working_directory: workingDirectory,
      signal: ctx.abortSignal,
    });
  } catch (err) {
    recordHealth(task.agent_type, model, false);
    throw err;
  }

  recordHealth(task.agent_type, response.model, true, Date.now() - startMs);

  // Track cost
  if (response.usage.cost.total_cost > 0) {
    ctx.creditsCallback(response.usage.cost.total_cost, task.task_id);
    debitCredits(
      ctx.userId,
      response.usage.cost.total_cost,
      `Agent task: ${task.task_id} (${task.agent_type})`,
      'workflow',
      ctx.workflowId
    ).catch((err: unknown) => {
      logger.error({ workflowId: ctx.workflowId, taskId: task.task_id, cost: response.usage.cost.total_cost, error: getErrorMessage(err) }, 'Failed to debit credits for agent task — balance may be inaccurate');
    });
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
  taskId?: string
): Promise<void> {
  const workingDirectory = normalizeWorkingDirectory(ctx.config.working_directory);
  const hasReusableWorkflowSession = (): boolean =>
    ctx.sandboxSessionIds.some((sessionId) => {
      const session = getSessionInfo(sessionId);
      if (!session) return false;
      if (session.chat_id !== chatId) return false;
      if ((session.working_directory ?? undefined) !== workingDirectory) return false;
      if (session.environment_status !== 'running') return false;
      return session.status === 'ready' || session.status === 'executing';
    });

  if (hasReusableWorkflowSession()) return;

  const lockKey = workspaceLockKey(ctx.userId, chatId);
  const inFlight = workspaceBootstrapLocks.get(lockKey);
  if (inFlight) {
    await inFlight;
    return;
  }

  const bootstrapPromise = (async () => {
    if (hasReusableWorkflowSession()) return;

    const existing = await getOpenTerminalSessionForChat(ctx.userId, chatId);
    const matchesRequestedWorkingDirectory = workingDirectory
      ? existing?.workingDirectory === workingDirectory
      : Boolean(existing);
    if (matchesRequestedWorkingDirectory) return;

    if (workingDirectory) {
      mkdirSync(workingDirectory, { recursive: true });
    }

    const session = await createSession(ctx.userId, {
      language: 'javascript',
      chat_id: chatId,
      ...(workingDirectory ? { working_directory: workingDirectory } : {}),
      ...(taskId ? { task_id: taskId } : {}),
    });

    if (!ctx.sandboxSessionIds.includes(session.id)) {
      ctx.sandboxSessionIds.push(session.id);
    }
  })();

  workspaceBootstrapLocks.set(lockKey, bootstrapPromise);
  try {
    await bootstrapPromise;
  } finally {
    if (workspaceBootstrapLocks.get(lockKey) === bootstrapPromise) {
      workspaceBootstrapLocks.delete(lockKey);
    }
  }
}

export async function ensureEnvironmentSession(
  ctx: AgentExecutionContext,
  taskId?: string
): Promise<void> {
  const chatId = ctx.config.chat_id ?? ctx.workflowId;
  await ensureWorkspaceSession(ctx, chatId, taskId);
}

export function getAgentModel(agentType: AgentType, overrides?: Record<string, string>, userId?: string): string {
  // First check overrides (from workflow config)
  if (overrides?.[agentType]) {
    return overrides[agentType];
  }
  // Then check runtime config (from CLI onboarding)
  const configModel = getConfigAgentModel(agentType, userId);
  if (configModel) {
    return configModel;
  }
  // Fall back to hardcoded default
  return AGENT_CONFIGS[agentType].model;
}

// Re-export sandbox utilities for cleanup
export { terminateSession };
