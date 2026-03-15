import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InvalidRequestError } from '@orchestrator/shared';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface AgentModels {
  research?: string;
  analyze?: string;
  write?: string;
  code?: string;
  file?: string;
}

export interface RuntimeModelConfig {
  default_orchestrator_model: string;
  orchestrator_models: string[];
  subagent_models: Record<string, string>;
  agent_models?: AgentModels;
  tools: {
    search_provider: string;
    fetch_provider: string;
    sandbox_runtime: string;
  };
}

const CONFIG_PATH = join(__dirname, 'model_config.json');

let modelConfig: RuntimeModelConfig = JSON.parse(
  readFileSync(CONFIG_PATH, 'utf-8')
) as RuntimeModelConfig;

export const getRuntimeModelConfig = (): RuntimeModelConfig => modelConfig;

export const getDefaultOrchestratorModel = (): string =>
  modelConfig.default_orchestrator_model;

export const getAllowedOrchestratorModels = (): string[] =>
  [...modelConfig.orchestrator_models];

export const resolveOrchestratorModel = (requestedModel?: string): string => {
  const model = requestedModel ?? modelConfig.default_orchestrator_model;

  if (!modelConfig.orchestrator_models.includes(model)) {
    throw new InvalidRequestError(
      `Unsupported orchestrator model: ${model}`,
      'orchestrator_model'
    );
  }

  return model;
};

export const getSubagentModel = (role: string, fallback: string): string =>
  modelConfig.subagent_models[role] ?? fallback;

/**
 * Get the model assigned to a specific agent type.
 * Falls back to the default orchestrator model if not configured.
 */
export const getAgentModel = (agentType: string): string => {
  const agentModels = modelConfig.agent_models;
  if (agentModels && agentType in agentModels) {
    return agentModels[agentType as keyof AgentModels]!;
  }
  return modelConfig.default_orchestrator_model;
};

/**
 * Get all agent model assignments.
 */
export const getAllAgentModels = (): AgentModels => {
  return modelConfig.agent_models ?? {};
};

/**
 * Save the runtime model configuration to disk.
 * This allows the CLI to persist model changes.
 */
export const saveRuntimeModelConfig = (config: RuntimeModelConfig): void => {
  modelConfig = config;
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
};

/**
 * Update agent model assignments.
 */
export const updateAgentModels = (agentModels: AgentModels): void => {
  modelConfig = {
    ...modelConfig,
    agent_models: {
      ...modelConfig.agent_models,
      ...agentModels,
    },
  };
  saveRuntimeModelConfig(modelConfig);
};
