import OpenAI from 'openai';
import { DEFAULT_LLM_TIMEOUT_MS, MAX_TOOL_ITERATIONS, getEnv, getErrorMessage, logger } from '@orchestrator/shared';
import type { AgentRequest, AgentResponse, ModelInfo, OutputBlock, StreamChunk } from '@orchestrator/shared';
import { BaseAdapter } from './base.js';
import {
  appendReasoningBlock,
  buildUsageInfo,
  extractReasoningText,
  OpenAIToolCallAccumulator,
} from './openai-compatible.js';
import { buildOpenAITools, executeToolCall } from '../tools/registry.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Lazily loaded models config — avoids sync I/O at import time
let _modelsConfig: { models: Array<{ id: string; target_model?: string }> } | null = null;

function getModelsConfig(): { models: Array<{ id: string; target_model?: string }> } {
  if (!_modelsConfig) {
    _modelsConfig = JSON.parse(readFileSync(join(__dirname, '../models.json'), 'utf-8'));
  }
  return _modelsConfig!;
}

interface LiteLLMConfig {
  baseURL: string;
  apiKey: string;
}

export class LiteLLMAdapter extends BaseAdapter {
  readonly provider = 'litellm';
  private client: OpenAI;
  private config: LiteLLMConfig;

  constructor(config?: LiteLLMConfig) {
    super();
    this.config = config ?? {
      baseURL: getEnv().LITELLM_BASE_URL,
      apiKey: getEnv().LITELLM_API_KEY,
    };

    this.client = new OpenAI({
      apiKey: this.config.apiKey,
      baseURL: this.config.baseURL,
      timeout: DEFAULT_LLM_TIMEOUT_MS,
    });

    logger.info(
      {
        baseURL: this.config.baseURL,
        provider: this.provider,
      },
      'LiteLLM adapter initialized'
    );
  }

  /**
   * Extract the target model name for LiteLLM.
   * Looks up the models.json for the target_model mapping,
   * otherwise uses the model ID after the provider prefix.
   */
  private extractLiteLLMModel(modelId: string): string {
    // Look up in models.json config directly (not DB, since target_model isn't persisted)
    const model = getModelsConfig().models.find((m) => m.id === modelId);
    if (model?.target_model) {
      return model.target_model;
    }
    // Default: strip provider prefix (delegates to BaseAdapter)
    return this.extractModelName(modelId);
  }

  async createResponse(request: AgentRequest): Promise<AgentResponse> {
    const modelName = this.extractLiteLLMModel(request.model!);
    const messages = this.buildMessages(request);
    const startTime = Date.now();
    const outputBlocks: OutputBlock[] = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let toolCallsCost = 0;

    logger.debug(
      {
        requestedModel: request.model,
        litellmModel: modelName,
        baseURL: this.config.baseURL,
      },
      'Calling LiteLLM'
    );

    // Tool use loop
    let currentMessages: OpenAI.ChatCompletionMessageParam[] = messages as OpenAI.ChatCompletionMessageParam[];
    let maxIterations = MAX_TOOL_ITERATIONS;
    // Retry budget for transient errors (429, 502, 503) per LLM call within the loop
    const MAX_TRANSIENT_RETRIES = 3;

    while (maxIterations > 0) {
      maxIterations--;
      const tools = buildOpenAITools(request.tools);

      const params: OpenAI.ChatCompletionCreateParamsNonStreaming = {
        model: modelName,
        messages: currentMessages as OpenAI.ChatCompletionMessageParam[],
        max_tokens: request.max_output_tokens,
        temperature: request.temperature,
      };

      if (tools && tools.length > 0) {
        params.tools = tools;
        params.parallel_tool_calls = true;
      }

      if (request.text?.format?.type === 'json_schema' && request.text.format.json_schema) {
        params.response_format = { type: 'json_object' };
      }

      let completion: OpenAI.ChatCompletion | null = null;
      for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt++) {
        try {
          completion = await this.client.chat.completions.create(params, { signal: request.signal });
          break; // Success — exit retry loop
        } catch (retryErr) {
          const status = (retryErr as { status?: number })?.status ?? 0;
          const isTransient = status === 429 || status === 502 || status === 503;
          if (!isTransient || attempt >= MAX_TRANSIENT_RETRIES || request.signal?.aborted) {
            throw retryErr;
          }
          const backoffMs = Math.min(1000 * Math.pow(2, attempt), 16_000);
          logger.warn(
            { requestedModel: request.model, litellmModel: modelName, status, attempt, backoffMs },
            'LiteLLM transient error — retrying with backoff'
          );
          await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));
        }
      }
      try {
        const choice = completion!.choices[0];

        totalInputTokens += completion!.usage?.prompt_tokens ?? 0;
        totalOutputTokens += completion!.usage?.completion_tokens ?? 0;

        if (!choice) {
          break;
        }

        // Check for tool calls
        if (choice.finish_reason === 'tool_calls' && choice.message.tool_calls) {
          if (request.tool_execution === 'manual') {
            const assistantText = choice.message.content ?? '';
            appendReasoningBlock(outputBlocks, extractReasoningText(choice.message));
            if (assistantText) {
              outputBlocks.push({ type: 'message', content: assistantText });
            }

            for (const toolCall of choice.message.tool_calls) {
              outputBlocks.push({
                type: 'tool_use',
                id: toolCall.id,
                name: toolCall.function.name,
                arguments: toolCall.function.arguments,
              });
            }

            const usage = buildUsageInfo(
              request.model!,
              totalInputTokens,
              totalOutputTokens,
              toolCallsCost,
              completion!.usage
            );

            return {
              id: this.generateId(),
              model: request.model!,
              status: 'completed',
              output: outputBlocks,
              output_text: assistantText,
              usage,
              tools: request.tools ?? [],
              created_at: startTime,
              completed_at: Date.now(),
            };
          }

          currentMessages.push({
            role: 'assistant',
            content: choice.message.content ?? '',
            tool_calls: choice.message.tool_calls,
          } as OpenAI.ChatCompletionAssistantMessageParam);

          for (const toolCall of choice.message.tool_calls) {
            const result = await executeToolCall(
              toolCall.function.name,
              toolCall.function.arguments,
              request,
              outputBlocks
            );
            toolCallsCost += result.cost;
            if (result.systemMessage) {
              currentMessages.push({
                role: 'system',
                content: result.systemMessage,
              } as OpenAI.ChatCompletionMessageParam);
            }

            currentMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: result.output,
            } as OpenAI.ChatCompletionToolMessageParam);
          }
          continue;
        }

        // Final response
        const text = choice.message.content ?? '';
        appendReasoningBlock(outputBlocks, extractReasoningText(choice.message));
        outputBlocks.push({ type: 'message', content: text });

        const usage = buildUsageInfo(
          request.model!,
          totalInputTokens,
          totalOutputTokens,
          toolCallsCost,
          completion!.usage
        );

        logger.info(
          {
            requestedModel: request.model,
            litellmModel: modelName,
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            totalCost: usage.cost.total_cost,
          },
          'LiteLLM request completed'
        );

        return {
          id: this.generateId(),
          model: request.model!,
          status: 'completed',
          output: outputBlocks,
          output_text: text,
          usage,
          tools: request.tools ?? [],
          created_at: startTime,
          completed_at: Date.now(),
        };
      } catch (err) {
        logger.error(
          {
            requestedModel: request.model,
            litellmModel: modelName,
            error: getErrorMessage(err),
            baseURL: this.config.baseURL,
          },
          'LiteLLM request failed'
        );
        throw err;
      }
    }

    // If we exhausted iterations
    const usage = buildUsageInfo(request.model!, totalInputTokens, totalOutputTokens, toolCallsCost);
    return {
      id: this.generateId(),
      model: request.model!,
      status: 'incomplete',
      output: outputBlocks,
      output_text: outputBlocks
        .filter((b) => b.type === 'message')
        .map((b) => b.content as string)
        .join('\n'),
      usage,
      tools: request.tools ?? [],
      created_at: startTime,
      completed_at: Date.now(),
    };
  }

  async *streamResponse(request: AgentRequest): AsyncIterable<StreamChunk> {
    const modelName = this.extractLiteLLMModel(request.model!);
    const messages = this.buildMessages(request);
    const tools = buildOpenAITools(request.tools);

    logger.debug(
      {
        requestedModel: request.model,
        litellmModel: modelName,
        baseURL: this.config.baseURL,
      },
      'Streaming from LiteLLM'
    );

    const params: OpenAI.ChatCompletionCreateParamsStreaming = {
      model: modelName,
      messages: messages as OpenAI.ChatCompletionMessageParam[],
      max_tokens: request.max_output_tokens,
      temperature: request.temperature,
      stream: true,
    };

    if (tools && tools.length > 0) {
      params.tools = tools;
      params.parallel_tool_calls = true;
    }

    try {
      const stream = await this.client.chat.completions.create(params, {
        signal: request.signal,
      });
      const toolAccumulator = new OpenAIToolCallAccumulator();

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (chunk.usage) {
          yield { type: 'usage', data: chunk.usage };
        }
        if (!delta) continue;

        const reasoning = extractReasoningText(delta);
        if (reasoning) {
          yield { type: 'reasoning_delta', text: reasoning };
        }

        if (delta.content) {
          yield { type: 'text_delta', text: delta.content };
        }

        if (delta.tool_calls) {
          toolAccumulator.ingest(delta.tool_calls);
        }

        const finishReason = chunk.choices[0]?.finish_reason;
        if (finishReason === 'tool_calls') {
          for (const toolChunk of toolAccumulator.flush()) {
            yield toolChunk;
          }
        }
      }

      // Flush any remaining tool calls not triggered by finish_reason === 'tool_calls'
      // (Gemini and some models report finish_reason 'stop' even when using tools)
      for (const toolChunk of toolAccumulator.flush()) {
        yield toolChunk;
      }

      yield { type: 'done' };
    } catch (err) {
      logger.error(
        {
          requestedModel: request.model,
          litellmModel: modelName,
          error: getErrorMessage(err),
        },
        'LiteLLM streaming failed'
      );
      yield { type: 'error', data: { message: getErrorMessage(err) } };
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const models = await this.client.models.list();
      return models.data.map((m) => ({
        id: `litellm/${m.id}`,
        provider: 'litellm',
        display_name: m.id,
        capabilities: [],
        cost_per_1m_input: 0,
        cost_per_1m_output: 0,
        context_window: 128000,
        max_output_tokens: 8192,
      }));
    } catch (err) {
      logger.warn({ baseURL: this.config.baseURL, error: getErrorMessage(err) }, 'LiteLLM model list failed');
      return [];
    }
  }
}
