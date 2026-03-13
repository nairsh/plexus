import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InvalidRequestError } from '@orchestrator/shared';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface RuntimeModelConfig {
  default_orchestrator_model: string;
  orchestrator_models: string[];
  subagent_models: Record<string, string>;
  tools: {
    search_provider: string;
    fetch_provider: string;
    sandbox_runtime: string;
  };
}

const modelConfig = JSON.parse(
  readFileSync(join(__dirname, 'model_config.json'), 'utf-8')
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
