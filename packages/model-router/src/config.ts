import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, getErrorMessage, InvalidRequestError, logger } from '@orchestrator/shared';

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

interface UserModelPreferencesRow {
  user_id: string;
  default_orchestrator_model: string | null;
  orchestrator_models: string | null;
  agent_models: string | null;
  subagent_models: string | null;
}

const readBaseConfig = (): RuntimeModelConfig => {
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as RuntimeModelConfig;
};

let modelConfig: RuntimeModelConfig = readBaseConfig();

const parseJsonArray = (value: string | null): string[] | null => {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    return null;
  }
};

const parseStringMap = (value: string | null): Record<string, string> | null => {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const result: Record<string, string> = {};
    for (const [key, entry] of Object.entries(record)) {
      if (typeof entry === 'string') {
        result[key] = entry;
      }
    }
    return result;
  } catch {
    return null;
  }
};

const getUserOverrides = (userId: string): Partial<RuntimeModelConfig> | null => {
  try {
    const row = getDb()
      .prepare(
        `SELECT user_id, default_orchestrator_model, orchestrator_models, agent_models, subagent_models
         FROM user_model_preferences
         WHERE user_id = ?`
      )
      .get(userId) as UserModelPreferencesRow | undefined;

    if (!row) return null;

    const orchestratorModels = parseJsonArray(row.orchestrator_models);
    const agentModels = parseStringMap(row.agent_models);
    const subagentModels = parseStringMap(row.subagent_models);

    return {
      ...(row.default_orchestrator_model ? { default_orchestrator_model: row.default_orchestrator_model } : {}),
      ...(orchestratorModels ? { orchestrator_models: orchestratorModels } : {}),
      ...(agentModels ? { agent_models: agentModels } : {}),
      ...(subagentModels ? { subagent_models: subagentModels } : {}),
    };
  } catch (error) {
    logger.debug({ userId, error: getErrorMessage(error) }, 'Failed to read user model preferences');
    return null;
  }
};

const mergeModelConfig = (base: RuntimeModelConfig, userId?: string): RuntimeModelConfig => {
  if (!userId) return base;
  const overrides = getUserOverrides(userId);
  if (!overrides) return base;

  const orchestratorModels =
    overrides.orchestrator_models && overrides.orchestrator_models.length > 0
      ? overrides.orchestrator_models
      : base.orchestrator_models;

  const defaultModel = overrides.default_orchestrator_model ?? base.default_orchestrator_model;

  return {
    ...base,
    ...overrides,
    orchestrator_models: [...orchestratorModels],
    default_orchestrator_model: orchestratorModels.includes(defaultModel)
      ? defaultModel
      : orchestratorModels[0] ?? base.default_orchestrator_model,
    agent_models: {
      ...(base.agent_models ?? {}),
      ...(overrides.agent_models ?? {}),
    },
    subagent_models: {
      ...base.subagent_models,
      ...(overrides.subagent_models ?? {}),
    },
  };
};

export const getRuntimeModelConfig = (userId?: string): RuntimeModelConfig => mergeModelConfig(modelConfig, userId);

export const getDefaultOrchestratorModel = (userId?: string): string => getRuntimeModelConfig(userId).default_orchestrator_model;

export const getAllowedOrchestratorModels = (userId?: string): string[] => [...getRuntimeModelConfig(userId).orchestrator_models];

export const resolveOrchestratorModel = (requestedModel?: string, userId?: string): string => {
  const runtime = getRuntimeModelConfig(userId);
  const model = requestedModel ?? runtime.default_orchestrator_model;

  if (!runtime.orchestrator_models.includes(model)) {
    throw new InvalidRequestError(`Unsupported orchestrator model: ${model}`, 'orchestrator_model');
  }

  return model;
};

export const getSubagentModel = (role: string, fallback: string, userId?: string): string =>
  getRuntimeModelConfig(userId).subagent_models[role] ?? fallback;

export const getAgentModel = (agentType: string, userId?: string): string => {
  const runtime = getRuntimeModelConfig(userId);
  const agentModels = runtime.agent_models;
  if (agentModels && agentType in agentModels) {
    return agentModels[agentType as keyof AgentModels]!;
  }
  return runtime.default_orchestrator_model;
};

export const getAllAgentModels = (userId?: string): AgentModels => {
  return getRuntimeModelConfig(userId).agent_models ?? {};
};

export const hasConfiguredModelMapping = (userId?: string): boolean => {
  const runtime = getRuntimeModelConfig(userId);
  return Boolean(
    runtime.default_orchestrator_model ||
    runtime.orchestrator_models.length > 0 ||
    Object.keys(runtime.subagent_models).length > 0 ||
    Boolean(runtime.agent_models && Object.keys(runtime.agent_models).length > 0)
  );
};

export const saveRuntimeModelConfig = (config: RuntimeModelConfig): void => {
  modelConfig = config;
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
};

export const saveUserRuntimeModelConfig = (userId: string, config: Partial<RuntimeModelConfig>): void => {
  const allowed = config.orchestrator_models ?? getAllowedOrchestratorModels(userId);
  if (config.default_orchestrator_model && !allowed.includes(config.default_orchestrator_model)) {
    throw new InvalidRequestError(
      `Unsupported orchestrator model: ${config.default_orchestrator_model}`,
      'orchestrator_model'
    );
  }

  const nextAgentModels = config.agent_models ?? null;
  const nextSubagentModels = config.subagent_models ?? null;

  getDb()
    .prepare(
      `INSERT INTO user_model_preferences (
         user_id,
         default_orchestrator_model,
         orchestrator_models,
         agent_models,
         subagent_models,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET
         default_orchestrator_model = excluded.default_orchestrator_model,
         orchestrator_models = excluded.orchestrator_models,
         agent_models = excluded.agent_models,
         subagent_models = excluded.subagent_models,
         updated_at = datetime('now')`
    )
    .run(
      userId,
      config.default_orchestrator_model ?? null,
      config.orchestrator_models ? JSON.stringify(config.orchestrator_models) : null,
      nextAgentModels ? JSON.stringify(nextAgentModels) : null,
      nextSubagentModels ? JSON.stringify(nextSubagentModels) : null
    );
};

export const clearUserRuntimeModelConfig = (userId: string): void => {
  getDb().prepare('DELETE FROM user_model_preferences WHERE user_id = ?').run(userId);
};

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
