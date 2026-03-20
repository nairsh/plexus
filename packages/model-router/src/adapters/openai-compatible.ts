import type { OutputBlock, StreamChunk, UsageInfo } from '@orchestrator/shared';
import { computeCost } from '../registry.js';

type OpenAIUsageLike = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
  prompt_tokens_details?: { cached_tokens?: number };
};

export const extractReasoningText = (value: unknown): string | undefined => {
  if (!value || typeof value !== 'object') return undefined;

  const maybeReasoning = value as {
    reasoning_content?: unknown;
    provider_specific_fields?: { reasoning_content?: unknown };
  };

  if (typeof maybeReasoning.reasoning_content === 'string' && maybeReasoning.reasoning_content.length > 0) {
    return maybeReasoning.reasoning_content;
  }

  if (
    typeof maybeReasoning.provider_specific_fields?.reasoning_content === 'string' &&
    maybeReasoning.provider_specific_fields.reasoning_content.length > 0
  ) {
    return maybeReasoning.provider_specific_fields.reasoning_content;
  }

  return undefined;
};

export const buildUsageInfo = (
  modelId: string,
  promptTokens: number,
  completionTokens: number,
  toolCallsCost: number,
  rawUsage?: OpenAIUsageLike
): UsageInfo => {
  const costInfo = computeCost(modelId, promptTokens, completionTokens);
  const totalTokens = promptTokens + completionTokens;
  return {
    input_tokens: promptTokens,
    output_tokens: completionTokens,
    total_tokens: rawUsage?.total_tokens && rawUsage.total_tokens > totalTokens ? rawUsage.total_tokens : totalTokens,
    reasoning_tokens: rawUsage?.completion_tokens_details?.reasoning_tokens,
    cached_input_tokens: rawUsage?.prompt_tokens_details?.cached_tokens,
    cost: {
      currency: 'USD',
      input_cost: costInfo.input_cost,
      output_cost: costInfo.output_cost,
      tool_calls_cost: toolCallsCost,
      total_cost: costInfo.total_cost + toolCallsCost,
    },
  };
};

interface ToolCallState {
  id?: string;
  name?: string;
  argumentsText: string;
}

export class OpenAIToolCallAccumulator {
  private readonly calls = new Map<number, ToolCallState>();

  ingest(rawToolCalls: unknown): void {
    if (!Array.isArray(rawToolCalls)) return;

    for (const item of rawToolCalls as Array<Record<string, unknown>>) {
      const index = typeof item.index === 'number' ? item.index : 0;
      const current = this.calls.get(index) ?? { argumentsText: '' };

      if (typeof item.id === 'string' && item.id.length > 0) {
        current.id = item.id;
      }

      const fn = item.function as { name?: unknown; arguments?: unknown } | undefined;
      if (typeof fn?.name === 'string' && fn.name.length > 0) {
        current.name = fn.name;
      }

      if (typeof fn?.arguments === 'string' && fn.arguments.length > 0) {
        current.argumentsText += fn.arguments;
      }

      this.calls.set(index, current);
    }
  }

  flush(): StreamChunk[] {
    const chunks: StreamChunk[] = [];

    for (const [index, call] of [...this.calls.entries()].sort(([a], [b]) => a - b)) {
      if (!call.name) continue;
      chunks.push({
        type: 'tool_use',
        data: {
          id: call.id,
          name: call.name,
          arguments: call.argumentsText,
        },
      });
      this.calls.delete(index);
    }

    return chunks;
  }
}

export const appendReasoningBlock = (outputBlocks: OutputBlock[], reasoningText: string | undefined): void => {
  if (!reasoningText) return;
  outputBlocks.push({ type: 'reasoning', content: reasoningText });
};
