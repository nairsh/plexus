/**
 * Configuration management for the orchestrator CLI.
 * Handles model_config.json and onboarding state.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '@orchestrator/shared';
import { setEnvVar, ENV_KEYS } from './env-manager.js';
import {
  getRuntimeModelConfig,
  saveRuntimeModelConfig,
  getAgentModel as getModelRouterAgentModel,
  getAllAgentModels as getModelRouterAllAgentModels,
  updateAgentModels as updateModelRouterAgentModels,
} from '@orchestrator/model-router';

// ── Types ──

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

export interface OnboardingState {
  completed: boolean;
  completedAt?: string;
  version: string;
  skipModelConfig?: boolean;
}

// ── Paths ──

export function getConfigDir(): string {
  return join(homedir(), '.orchestrator');
}

export function getOnboardingPath(): string {
  return join(getConfigDir(), 'onboarding.json');
}

export function getModelConfigPath(): string {
  // This returns the path used by model-router
  // The actual path is in packages/model-router/src/model_config.json
  return 'model-router/src/model_config.json';
}

// ── Onboarding State ──

export function getOnboardingState(): OnboardingState | null {
  const path = getOnboardingPath();

  if (!existsSync(path)) {
    return null;
  }

  try {
    const content = readFileSync(path, 'utf-8');
    return JSON.parse(content) as OnboardingState;
  } catch (error) {
    logger.warn({ error }, 'Failed to read onboarding state');
    return null;
  }
}

export function setOnboardingState(state: Partial<OnboardingState>): void {
  const path = getOnboardingPath();
  const dir = dirname(path);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const existing = getOnboardingState() ?? {
    completed: false,
    version: '1.0.0',
  };

  const updated: OnboardingState = {
    ...existing,
    ...state,
  };

  writeFileSync(path, JSON.stringify(updated, null, 2), 'utf-8');
  logger.debug({ path }, 'Updated onboarding state');
}

export function isOnboardingComplete(): boolean {
  const state = getOnboardingState();
  return state?.completed ?? false;
}

export function completeOnboarding(options?: { skipModelConfig?: boolean }): void {
  setOnboardingState({
    completed: true,
    completedAt: new Date().toISOString(),
    skipModelConfig: options?.skipModelConfig,
  });
}

export function resetOnboarding(): void {
  const path = getOnboardingPath();
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

// ── Model Config ──

/**
 * Get the model configuration from model-router.
 * This reads from the canonical model_config.json.
 */
export function getModelConfig(): RuntimeModelConfig | null {
  try {
    return getRuntimeModelConfig() as RuntimeModelConfig;
  } catch (error) {
    logger.warn({ error }, 'Failed to read model config');
    return null;
  }
}

/**
 * Save the model configuration via model-router.
 */
export function saveModelConfig(config: RuntimeModelConfig): void {
  saveRuntimeModelConfig(config as import('@orchestrator/model-router').RuntimeModelConfig);
  logger.debug('Saved model config');
}

export function getDefaultModelConfig(): RuntimeModelConfig {
  return {
    default_orchestrator_model: 'litellm/gemini-3.1-flash-lite-preview',
    orchestrator_models: [
      'litellm/gemini-3.1-flash-lite-preview',
      'litellm/gemini-3-flash-preview',
      'litellm/gemini-3.1-pro-preview',
    ],
    subagent_models: {
      llm_completion: 'litellm/gemini-3-flash-preview',
      code_execution_planner: 'litellm/gemini-3.1-flash-lite-preview',
      file_operation_planner: 'litellm/gemini-3.1-flash-lite-preview',
    },
    agent_models: {
      research: 'litellm/gemini-3-flash-preview',
      analyze: 'litellm/gemini-3-flash-preview',
      write: 'litellm/gemini-3-flash-preview',
      code: 'litellm/gemini-3-flash-preview',
      file: 'litellm/gemini-3.1-flash-lite-preview',
    },
    tools: {
      search_provider: 'tavily',
      fetch_provider: 'tavily',
      sandbox_runtime: 'open_terminal',
    },
  };
}

// ── Model Config Updates ──

export function updateOrchestratorModels(models: string[], defaultModel?: string): void {
  const config = getModelConfig() ?? getDefaultModelConfig();

  config.orchestrator_models = models;
  if (defaultModel && models.includes(defaultModel)) {
    config.default_orchestrator_model = defaultModel;
  } else if (models.length > 0) {
    config.default_orchestrator_model = models[0];
  }

  saveModelConfig(config);
}

export function updateAgentModels(agentModels: AgentModels): void {
  updateModelRouterAgentModels(agentModels as import('@orchestrator/model-router').AgentModels);
}

export function setAgentModel(agentType: string, model: string): void {
  updateModelRouterAgentModels({ [agentType]: model } as import('@orchestrator/model-router').AgentModels);
}

export function getAgentModel(agentType: string): string | undefined {
  return getModelRouterAgentModel(agentType);
}

export function getAllAgentModels(): AgentModels {
  return getModelRouterAllAgentModels() as AgentModels;
}

// ── Key mapping for config command ──

export type ConfigKey =
  | 'litellm.baseUrl'
  | 'litellm.apiKey'
  | 'tavily.apiKey'
  | 'models.default'
  | 'models.orchestrator'
  | 'models.research'
  | 'models.analyze'
  | 'models.write'
  | 'models.code'
  | 'models.file';

export function getConfigValue(key: ConfigKey): string | undefined {
  const envPath = '.env';

  switch (key) {
    case 'litellm.baseUrl':
      return process.env.LITELLM_BASE_URL;
    case 'litellm.apiKey':
      return process.env.LITELLM_API_KEY;
    case 'tavily.apiKey':
      return process.env.TAVILY_API_KEY;
    case 'models.default': {
      const config = getModelConfig();
      return config?.default_orchestrator_model;
    }
    case 'models.orchestrator': {
      const config = getModelConfig();
      return config?.orchestrator_models?.join(', ');
    }
    case 'models.research':
    case 'models.analyze':
    case 'models.write':
    case 'models.code':
    case 'models.file': {
      const agentType = key.split('.')[1] as keyof AgentModels;
      return getAgentModel(agentType);
    }
    default:
      return undefined;
  }
}

export function setConfigValue(key: ConfigKey, value: string, envPath: string = '.env'): void {
  switch (key) {
    case 'litellm.baseUrl':
      setEnvVar(envPath, ENV_KEYS.LITELLM_BASE_URL, value);
      break;
    case 'litellm.apiKey':
      setEnvVar(envPath, ENV_KEYS.LITELLM_API_KEY, value);
      break;
    case 'tavily.apiKey':
      setEnvVar(envPath, ENV_KEYS.TAVILY_API_KEY, value);
      break;
    case 'models.default': {
      const config = getModelConfig() ?? getDefaultModelConfig();
      if (config.orchestrator_models.includes(value)) {
        config.default_orchestrator_model = value;
        saveModelConfig(config);
      } else {
        throw new Error(`Model ${value} is not in the allowed orchestrator models list`);
      }
      break;
    }
    case 'models.orchestrator': {
      const models = value.split(',').map(m => m.trim());
      updateOrchestratorModels(models);
      break;
    }
    case 'models.research':
    case 'models.analyze':
    case 'models.write':
    case 'models.code':
    case 'models.file': {
      const agentType = key.split('.')[1];
      setAgentModel(agentType, value);
      break;
    }
  }
}