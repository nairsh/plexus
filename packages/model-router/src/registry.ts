import { getDb, logger } from '@orchestrator/shared';
import type { ModelInfo, ModelRegistryRow, Preset } from '@orchestrator/shared';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const modelsConfig = JSON.parse(readFileSync(join(__dirname, 'models.json'), 'utf-8'));
const presetsConfig = JSON.parse(readFileSync(join(__dirname, 'presets.json'), 'utf-8'));

interface RoutingRule {
  primary: string;
  fallbacks: string[];
}

interface ModelsJson {
  default_model: string;
  routing_rules: Record<string, RoutingRule>;
  models: Array<{
    id: string;
    provider: string;
    display_name: string;
    capabilities: string[];
    cost_per_1m_input: number;
    cost_per_1m_output: number;
    max_output_tokens: number;
    context_window: number;
    supports_streaming: boolean;
    supports_tools: boolean;
    fallback_models: string[];
  }>;
}

const config = modelsConfig as ModelsJson;
const presets = presetsConfig as Record<string, Preset>;

export function getDefaultModel(): string {
  return config.default_model;
}

export function getPreset(name: string): Preset | null {
  return presets[name] ?? null;
}

export function getAllPresets(): Record<string, Preset> {
  return { ...presets };
}

export function seedModelRegistry(): void {
  const db = getDb();
  const upsert = db.prepare(`
    INSERT INTO model_registry (id, provider, display_name, capabilities, cost_per_1m_input, cost_per_1m_output, max_output_tokens, context_window, supports_streaming, supports_tools, status, fallback_models, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      provider = excluded.provider,
      display_name = excluded.display_name,
      capabilities = excluded.capabilities,
      cost_per_1m_input = excluded.cost_per_1m_input,
      cost_per_1m_output = excluded.cost_per_1m_output,
      max_output_tokens = excluded.max_output_tokens,
      context_window = excluded.context_window,
      supports_streaming = excluded.supports_streaming,
      supports_tools = excluded.supports_tools,
      fallback_models = excluded.fallback_models,
      updated_at = datetime('now')
  `);

  const insertMany = db.transaction(() => {
    for (const model of config.models) {
      upsert.run(
        model.id,
        model.provider,
        model.display_name,
        JSON.stringify(model.capabilities),
        model.cost_per_1m_input,
        model.cost_per_1m_output,
        model.max_output_tokens,
        model.context_window,
        model.supports_streaming ? 1 : 0,
        model.supports_tools ? 1 : 0,
        JSON.stringify(model.fallback_models)
      );
    }
  });

  insertMany();
  logger.info({ count: config.models.length }, 'Model registry seeded');
}

function rowToModelInfo(row: ModelRegistryRow): ModelInfo {
  return {
    id: row.id,
    provider: row.provider,
    display_name: row.display_name,
    capabilities: JSON.parse(row.capabilities) as string[],
    cost_per_1m_input: row.cost_per_1m_input,
    cost_per_1m_output: row.cost_per_1m_output,
    context_window: row.context_window ?? 128000,
    max_output_tokens: row.max_output_tokens ?? 8192,
  };
}

export function getModelInfo(modelId: string): ModelInfo | null {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM model_registry WHERE id = ? AND status = ?')
    .get(modelId, 'active') as ModelRegistryRow | undefined;

  return row ? rowToModelInfo(row) : null;
}

export function getAllModels(): ModelInfo[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM model_registry WHERE status = ?')
    .all('active') as ModelRegistryRow[];

  return rows.map(rowToModelInfo);
}

export function getFallbackChain(modelId: string): string[] {
  const db = getDb();
  const row = db
    .prepare('SELECT fallback_models FROM model_registry WHERE id = ?')
    .get(modelId) as { fallback_models: string | null } | undefined;

  if (!row?.fallback_models) return [];
  return JSON.parse(row.fallback_models) as string[];
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
