import { getErrorMessage, logger, ModelError } from '@orchestrator/shared';
import type { AgentRequest, AgentResponse, ModelAdapter } from '@orchestrator/shared';
import { getModelInfo, getPreset, getDefaultModel, getAllModels } from './registry.js';
import { hasConfiguredModelMapping } from './config.js';
import { ensureRunSkillTool } from './skills.js';
import { OpenAIAdapter } from './adapters/openai.js';
import { AnthropicAdapter } from './adapters/anthropic.js';
import { GoogleAdapter } from './adapters/google.js';
import { LiteLLMAdapter } from './adapters/litellm.js';

const adapters = new Map<string, ModelAdapter>();

function getOrCreateAdapter(provider: string): ModelAdapter {
  const existing = adapters.get(provider);
  if (existing) return existing;

  let adapter: ModelAdapter;
  switch (provider) {
    case 'openai':
      adapter = new OpenAIAdapter();
      break;
    case 'anthropic':
      adapter = new AnthropicAdapter();
      break;
    case 'google':
      adapter = new GoogleAdapter();
      break;
    case 'litellm':
      adapter = new LiteLLMAdapter();
      break;
    default:
      throw new ModelError(`Unsupported provider: ${provider}`, 'unsupported_provider');
  }

  adapters.set(provider, adapter);
  return adapter;
}

export function parseModelId(modelId: string): { provider: string; model: string } {
  const slash = modelId.indexOf('/');
  if (slash === -1) {
    throw new ModelError(`Invalid model ID format: ${modelId}. Expected "provider/model"`, 'invalid_model_id');
  }
  return {
    provider: modelId.substring(0, slash),
    model: modelId.substring(slash + 1),
  };
}

export function resolveRequest(request: AgentRequest): AgentRequest {
  if (!hasConfiguredModelMapping()) {
    throw new ModelError('No model mapping is configured', 'no_model_mapping');
  }

  // If a preset is specified, merge preset config into the request
  if (request.preset) {
    const preset = getPreset(request.preset);
    if (!preset) {
      throw new ModelError(`Unknown preset: ${request.preset}`, 'unknown_preset');
    }
    return {
      ...request,
      model: request.model || preset.model,
      tools: ensureRunSkillTool(request.tools ?? preset.tools),
      max_output_tokens: request.max_output_tokens ?? preset.max_output_tokens,
      instructions: request.instructions ?? preset.instructions,
    };
  }

  // If no model specified, use default
  if (!request.model) {
    const defaultModel = getDefaultModel();
    if (!defaultModel) {
      throw new ModelError('No models are configured', 'no_models_configured');
    }

    return { ...request, model: defaultModel, tools: ensureRunSkillTool(request.tools) };
  }

  return { ...request, tools: ensureRunSkillTool(request.tools) };
}

export async function routeRequest(request: AgentRequest): Promise<AgentResponse> {
  const resolved = resolveRequest(request);
  const modelId = resolved.model!;

  const chain = buildFallbackChain(modelId);

  let lastError: Error | null = null;

  for (const currentModelId of chain) {
    try {
      const info = getModelInfo(currentModelId);
      if (!info) {
        lastError = new ModelError(`Model not found in registry: ${currentModelId}`, 'model_not_found');
        logger.warn({ modelId: currentModelId }, 'Model not found in registry, skipping');
        continue;
      }

      const adapter = getOrCreateAdapter(info.provider);
      const response = await adapter.createResponse({ ...resolved, model: currentModelId });
      return response;
    } catch (err) {
      lastError = err as Error;
      logger.warn({ modelId: currentModelId, error: getErrorMessage(err) }, 'Model call failed, trying fallback');
    }
  }

  const lastErrorMessage = lastError ? getErrorMessage(lastError) : 'unknown error';
  throw new ModelError(`All models in fallback chain failed. Last error: ${lastErrorMessage}`, 'all_models_failed');
}

export async function* routeStreamingRequest(
  request: AgentRequest
): AsyncIterable<import('@orchestrator/shared').StreamChunk> {
  const resolved = resolveRequest(request);
  const modelId = resolved.model!;

  const chain = buildFallbackChain(modelId);

  let lastError: Error | null = null;

  for (const currentModelId of chain) {
    try {
      const info = getModelInfo(currentModelId);
      if (!info) {
        lastError = new ModelError(`Model not found in registry: ${currentModelId}`, 'model_not_found');
        continue;
      }

      const adapter = getOrCreateAdapter(info.provider);
      yield* adapter.streamResponse({ ...resolved, model: currentModelId });
      return;
    } catch (err) {
      lastError = err as Error;
      logger.warn(
        { modelId: currentModelId, error: getErrorMessage(err) },
        'Streaming model call failed, trying fallback'
      );
    }
  }

  const lastErrorMessage = lastError ? getErrorMessage(lastError) : 'unknown error';
  yield {
    type: 'error',
    data: { message: `All models failed. Last error: ${lastErrorMessage}` },
  };
}

export function getAdapter(provider: string): ModelAdapter {
  return getOrCreateAdapter(provider);
}

function buildFallbackChain(requestedModelId: string): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();

  const push = (id: string | null | undefined) => {
    if (!id) return;
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    chain.push(trimmed);
  };

  push(requestedModelId);
  push(getDefaultModel());
  push(getAllModels()[0]?.id);

  return chain;
}
