/**
 * Specialized sub-agent system.
 *
 * Each AgentType has a dedicated system prompt, allowed tools, and preferred model.
 * The orchestrator dispatches tasks to these agents; they return their output as a string.
 */

import { routeRequest, getOpenTerminalSessionForChat, getAgentModel as getConfigAgentModel } from '@orchestrator/model-router';
import { debitCredits } from '@orchestrator/billing';
import { createSession, execute as sandboxExecute, terminateSession } from '@orchestrator/sandbox';
import { logger } from '@orchestrator/shared';
import type {
  AgentType,
  OrchestratorTask,
  WorkflowConfig,
  ToolTraceHooks,
  SubagentExecutionResult,
} from '@orchestrator/shared';

// ── Agent configuration ──

interface AgentConfig {
  /** Preferred model — falls back to orchestratorModel if not available */
  model: string;
  /** Tools this agent may use */
  tools: Array<{ type: string }>;
  /** System prompt injected as instructions */
  systemPrompt: string;
}

const AGENT_CONFIGS: Record<AgentType, AgentConfig> = {
  research: {
    model: 'litellm/gemini-3-flash-preview',
    tools: [{ type: 'web_search' }, { type: 'fetch_url' }],
    systemPrompt: `You are a research specialist. Your sole job is to gather accurate, up-to-date information.

Guidelines:
- Search thoroughly using multiple queries to cover different angles
- Fetch full page content when snippets are insufficient
- Structure your findings clearly: key facts, dates, sources, and any notable quotes
- Be objective — report what sources say, not your interpretation
- Always cite the source URLs inline
- If search results are contradictory, note the discrepancy
- Return comprehensive findings, not a summary — the analyst will synthesize later`,
  },

  analyze: {
    model: 'litellm/ali-kimi-k2.5',
    tools: [],
    systemPrompt: `You are an expert analyst. You receive research findings and produce structured analysis.

Guidelines:
- Identify patterns, trends, and key insights across all provided sources
- Cross-reference claims — flag contradictions or gaps in the evidence
- Separate verified facts from speculation or opinion
- Explicitly label evidence strength: confirmed, likely inference, or unknown
- Normalize scope when the input covers an ecosystem or product family; say what is included and excluded
- Quantify where possible (percentages, timelines, magnitudes)
- Note what is still unknown or requires further research
- Structure output with clear headers: Scope, Strongest Findings, Likely Inferences, Gaps, Conclusion
- Be concise but thorough — your output will feed directly into the final report`,
  },

  write: {
    model: 'litellm/ali-kimi-k2.5',
    tools: [],
    systemPrompt: `You are a professional writer. You produce polished, well-structured content from research and analysis.

Guidelines:
- Match tone and format to the context (report, summary, article, etc.)
- Use clear, direct language — avoid jargon unless the context demands it
- Structure content logically: introduction, body with clear sections, conclusion
- Cite sources naturally in context
- Do not fabricate facts — use only what is provided in your context
- Produce the complete final output in one pass — do not summarize or truncate
- Make confidence visible: separate strong evidence from inference and call out remaining uncertainty
- State the scope explicitly when the request involves a broad ecosystem or family of libraries
- Prefer bullets and short sections over large markdown tables that render poorly in terminals
- Format using markdown headers and bullet points where appropriate`,
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
    ],
    systemPrompt: `You are a coding assistant. You write, execute, and verify code to accomplish tasks.

Guidelines:
- Understand the full requirement before writing code
- Write clean, well-commented code
- Execute the code and verify it produces the expected output
- Handle errors gracefully — if execution fails, debug and retry
- Report what was done, what the output was, and any issues encountered
- Use bash for shell commands; use file tools for reading and writing files
- Check your work: read files back after writing to confirm correctness`,
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
    ],
    systemPrompt: `You are a file operations assistant. You manage files and directories in the workspace precisely.

Guidelines:
- Confirm what exists before creating or modifying
- Use the right tool for each operation (file_read to read, file_write to create, file_edit to modify)
- Use bash for complex operations like cloning, installing, or running scripts
- Report exactly what was created, modified, or deleted
- Verify your operations: read files back after writing to confirm success`,
  },
};

// ── Execution context passed from engine ──

export interface AgentExecutionContext {
  workflowId: string;
  userId: string;
  orchestratorModel: string;
  config: WorkflowConfig;
  sandboxSessionIds: string[];
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
    instructions: config.systemPrompt,
    tools: config.tools.length > 0 ? (config.tools as import('@orchestrator/shared').Tool[]) : undefined,
    max_output_tokens: 8192,
    temperature: task.agent_type === 'write' ? 0.3 : 0.1,
    trace: ctx.trace,
    chat_id: chatId,
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
    } catch {
      // Non-critical
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
