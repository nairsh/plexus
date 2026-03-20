import { getDb, logger } from '@orchestrator/shared';
import type { ModelInfo, ModelRegistryRow, Preset } from '@orchestrator/shared';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getRuntimeModelConfig } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const presetsConfig = JSON.parse(readFileSync(join(__dirname, 'presets.json'), 'utf-8'));
const presets = presetsConfig as Record<string, Preset>;

const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
const DEFAULT_CONTEXT_WINDOW = 128000;

function toModelInfo(id: string, provider: string, displayName?: string): ModelInfo {
  return {
    id,
    provider,
    display_name: displayName ?? id,
    capabilities: [],
    cost_per_1m_input: 0,
    cost_per_1m_output: 0,
    context_window: DEFAULT_CONTEXT_WINDOW,
    max_output_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
  };
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown | null> {
  try {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      return null;
    }

    return (await response.json()) as unknown;
  } catch (error) {
    logger.debug({ url, error: error instanceof Error ? error.message : String(error) }, 'Model discovery failed');
    return null;
  }
}

async function fetchLiteLLMModels(): Promise<ModelInfo[]> {
  const baseUrl = process.env.LITELLM_BASE_URL;
  const apiKey = process.env.LITELLM_API_KEY;

  if (!baseUrl || !apiKey) return [];

  const data = await fetchJson(new URL('/v1/models', baseUrl).toString(), {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!data || typeof data !== 'object') return [];

  const payload = data as { data?: Array<{ id?: string }>; models?: Array<{ id?: string }>; object?: string };
  const models = payload.data ?? payload.models ?? [];

  return models
    .map((model) => model.id?.trim())
    .filter((id): id is string => Boolean(id))
    .map((id) => toModelInfo(`litellm/${id}`, 'litellm', id));
}

async function fetchOpenAIModels(): Promise<ModelInfo[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return [];

  const data = await fetchJson('https://api.openai.com/v1/models', {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!data || typeof data !== 'object') return [];

  const payload = data as { data?: Array<{ id?: string }> };
  return (payload.data ?? [])
    .map((model) => model.id?.trim())
    .filter((id): id is string => Boolean(id))
    .map((id) => toModelInfo(`openai/${id}`, 'openai', id));
}

async function fetchAnthropicModels(): Promise<ModelInfo[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return [];

  const data = await fetchJson('https://api.anthropic.com/v1/models', {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
  });

  if (!data || typeof data !== 'object') return [];

  const payload = data as { data?: Array<{ id?: string; display_name?: string }> };
  return (payload.data ?? [])
    .map((model) => {
      const id = model.id?.trim();
      if (!id) return null;
      return toModelInfo(`anthropic/${id}`, 'anthropic', model.display_name ?? id);
    })
    .filter((model): model is ModelInfo => model !== null);
}

async function fetchGoogleModels(): Promise<ModelInfo[]> {
  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) return [];

  const data = await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`
  );
  if (!data || typeof data !== 'object') return [];

  const payload = data as { models?: Array<{ name?: string; displayName?: string }> };
  return (payload.models ?? [])
    .map((model) => {
      const rawName = model.name?.trim();
      if (!rawName) return null;
      const id = rawName.startsWith('models/') ? rawName.slice('models/'.length) : rawName;
      return toModelInfo(`google/${id}`, 'google', model.displayName ?? id);
    })
    .filter((model): model is ModelInfo => model !== null);
}

export async function discoverAvailableModels(): Promise<ModelInfo[]> {
  const results = await Promise.all([
    fetchLiteLLMModels(),
    fetchOpenAIModels(),
    fetchAnthropicModels(),
    fetchGoogleModels(),
  ]);

  const unique = new Map<string, ModelInfo>();
  for (const models of results) {
    for (const model of models) {
      if (!unique.has(model.id)) {
        unique.set(model.id, model);
      }
    }
  }

  return [...unique.values()];
}

export function getDefaultModel(): string {
  const configuredDefault = getRuntimeModelConfig().default_orchestrator_model;
  if (configuredDefault) {
    const info = getModelInfo(configuredDefault);
    if (info) return configuredDefault;
  }

  const firstModel = getAllModels()[0];
  return firstModel?.id ?? '';
}

export function getPreset(name: string): Preset | null {
  return presets[name] ?? null;
}

export function getAllPresets(): Record<string, Preset> {
  return { ...presets };
}

export function replaceModelRegistry(models: ModelInfo[]): void {
  const db = getDb();

  const insert = db.prepare(`
    INSERT INTO model_registry (
      id,
      provider,
      display_name,
      capabilities,
      cost_per_1m_input,
      cost_per_1m_output,
      max_output_tokens,
      context_window,
      supports_streaming,
      supports_tools,
      status,
      fallback_models,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, datetime('now'))
  `);

  const refresh = db.transaction((rows: ModelInfo[]) => {
    db.prepare('DELETE FROM model_registry').run();

    for (const model of rows) {
      insert.run(
        model.id,
        model.provider,
        model.display_name,
        JSON.stringify(model.capabilities ?? []),
        model.cost_per_1m_input,
        model.cost_per_1m_output,
        model.max_output_tokens,
        model.context_window,
        1,
        1,
        JSON.stringify([])
      );
    }
  });

  refresh(models);
  logger.info({ count: models.length }, 'Model registry refreshed');
}

export async function seedModelRegistry(): Promise<void> {
  const models = await discoverAvailableModels();
  replaceModelRegistry(models);
  if (!models.length) {
    logger.warn('No configured models discovered');
  }
}

function rowToModelInfo(row: ModelRegistryRow): ModelInfo {
  return {
    id: row.id,
    provider: row.provider,
    display_name: row.display_name,
    capabilities: JSON.parse(row.capabilities) as string[],
    cost_per_1m_input: row.cost_per_1m_input,
    cost_per_1m_output: row.cost_per_1m_output,
    context_window: row.context_window ?? 0,
    max_output_tokens: row.max_output_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
  };
}

export function getModelInfo(modelId: string): ModelInfo | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM model_registry WHERE id = ? AND status = ?').get(modelId, 'active') as
    | ModelRegistryRow
    | undefined;

  return row ? rowToModelInfo(row) : null;
}

export function getAllModels(): ModelInfo[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM model_registry WHERE status = ? ORDER BY provider, display_name')
    .all('active') as ModelRegistryRow[];

  return rows.map(rowToModelInfo);
}

export function getFallbackChain(_modelId: string): string[] {
  return [];
}

export function computeCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number
): { input_cost: number; output_cost: number; total_cost: number } {
  const info = getModelInfo(modelId);
  if (!info) {
    return { input_cost: 0, output_cost: 0, total_cost: 0 };
  }

  const input_cost = (inputTokens / 1_000_000) * info.cost_per_1m_input;
  const output_cost = (outputTokens / 1_000_000) * info.cost_per_1m_output;

  return {
    input_cost: Math.round(input_cost * 1_000_000) / 1_000_000,
    output_cost: Math.round(output_cost * 1_000_000) / 1_000_000,
    total_cost: Math.round((input_cost + output_cost) * 1_000_000) / 1_000_000,
  };
}
