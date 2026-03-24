import Anthropic from '@anthropic-ai/sdk';
import { DEFAULT_LLM_TIMEOUT_MS, MAX_TOOL_ITERATIONS, getEnv, getErrorMessage } from '@orchestrator/shared';
import type { AgentRequest, AgentResponse, ModelInfo, OutputBlock, StreamChunk, UsageInfo } from '@orchestrator/shared';
import { BaseAdapter } from './base.js';
import { computeCost } from '../registry.js';
import { buildAnthropicTools, executeToolCall } from '../tools/registry.js';

export class AnthropicAdapter extends BaseAdapter {
  readonly provider = 'anthropic';
  private client: Anthropic;

  constructor() {
    super();
    this.client = new Anthropic({
      apiKey: getEnv().ANTHROPIC_API_KEY,
      timeout: DEFAULT_LLM_TIMEOUT_MS,
    });
  }

  async createResponse(request: AgentRequest): Promise<AgentResponse> {
    const modelName = this.extractModelName(request.model!);
    const messages = this.buildAnthropicMessages(request);
    const startTime = Date.now();
    const outputBlocks: OutputBlock[] = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let toolCallsCost = 0;

    let currentMessages = [...messages];
    let maxIterations = MAX_TOOL_ITERATIONS;

    while (maxIterations > 0) {
      maxIterations--;
      const system = request.instructions || undefined;
      const tools = buildAnthropicTools(request.tools);

      const params: Anthropic.MessageCreateParamsNonStreaming = {
        model: modelName,
        max_tokens: request.max_output_tokens ?? 8192,
        messages: currentMessages,
        ...(system ? { system } : {}),
        ...(tools && tools.length > 0 ? { tools } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      };

      const response = await this.client.messages.create(params, {
        signal: request.signal,
      });

      totalInputTokens += response.usage.input_tokens;
      totalOutputTokens += response.usage.output_tokens;

      // Process content blocks
      const textParts: string[] = [];
      const toolUseBlocks: Array<{ id: string; name: string; input: unknown }> = [];

      for (const block of response.content) {
        if (block.type === 'text') {
          textParts.push(block.text);
        } else if (block.type === 'tool_use') {
          toolUseBlocks.push({
            id: block.id,
            name: block.name,
            input: block.input,
          });
        }
      }

      if (toolUseBlocks.length > 0 && response.stop_reason === 'tool_use') {
        // Add assistant message with tool use
        currentMessages.push({
          role: 'assistant',
          content: response.content as Anthropic.ContentBlock[],
        });

        // Execute tools and add results
        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        for (const tu of toolUseBlocks) {
          const result = await executeToolCall(tu.name, tu.input, request, outputBlocks);
          toolCallsCost += result.cost;
          if (result.systemMessage) {
            currentMessages.push({
              role: 'assistant',
              content: [{ type: 'text', text: result.systemMessage }],
            });
          }
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: result.output,
          });
        }

        currentMessages.push({
          role: 'user',
          content: toolResults,
        });

        continue;
      }

      // Final response
      const fullText = textParts.join('\n');
      const reasoningText = response.content
        .filter((block): block is Anthropic.ThinkingBlock => block.type === 'thinking')
        .map((block) => block.thinking)
        .join('\n');
      if (reasoningText) {
        outputBlocks.push({ type: 'reasoning', content: reasoningText });
      }
      outputBlocks.push({ type: 'message', content: fullText });

      const costInfo = computeCost(request.model!, totalInputTokens, totalOutputTokens);
      const usage: UsageInfo = {
        input_tokens: totalInputTokens,
        output_tokens: totalOutputTokens,
        total_tokens: totalInputTokens + totalOutputTokens,
        cost: {
          currency: 'USD',
          input_cost: costInfo.input_cost,
          output_cost: costInfo.output_cost,
          tool_calls_cost: toolCallsCost,
          total_cost: costInfo.total_cost + toolCallsCost,
        },
      };

      return {
        id: this.generateId(),
        model: request.model!,
        status: 'completed',
        output: outputBlocks,
        output_text: fullText,
        usage,
        tools: request.tools ?? [],
        created_at: startTime,
        completed_at: Date.now(),
      };
    }

    const costInfo = computeCost(request.model!, totalInputTokens, totalOutputTokens);
    return {
      id: this.generateId(),
      model: request.model!,
      status: 'incomplete',
      output: outputBlocks,
      output_text: outputBlocks
        .filter((b) => b.type === 'message')
        .map((b) => b.content as string)
        .join('\n'),
      usage: {
        input_tokens: totalInputTokens,
        output_tokens: totalOutputTokens,
        total_tokens: totalInputTokens + totalOutputTokens,
        cost: {
          currency: 'USD',
          input_cost: costInfo.input_cost,
          output_cost: costInfo.output_cost,
          tool_calls_cost: toolCallsCost,
          total_cost: costInfo.total_cost + toolCallsCost,
        },
      },
      tools: request.tools ?? [],
      created_at: startTime,
      completed_at: Date.now(),
    };
  }

  async *streamResponse(request: AgentRequest): AsyncIterable<StreamChunk> {
    const modelName = this.extractModelName(request.model!);
    const messages = this.buildAnthropicMessages(request);
    const system = request.instructions || undefined;
    const tools = buildAnthropicTools(request.tools);

    try {
      const stream = this.client.messages.stream(
        {
          model: modelName,
          max_tokens: request.max_output_tokens ?? 8192,
          messages,
          ...(system ? { system } : {}),
          ...(tools && tools.length > 0 ? { tools } : {}),
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        },
        {
          signal: request.signal,
        }
      );

      // Track in-progress tool_use blocks; keyed by content block index.
      const toolBlocks = new Map<number, { id: string; name: string; jsonParts: string[] }>();

      for await (const event of stream) {
        if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
          toolBlocks.set(event.index, {
            id: event.content_block.id,
            name: event.content_block.name,
            jsonParts: [],
          });
        } else if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            yield { type: 'text_delta', text: event.delta.text };
          } else if (event.delta.type === 'thinking_delta') {
            yield { type: 'reasoning_delta', text: event.delta.thinking };
          } else if (event.delta.type === 'input_json_delta') {
            const block = toolBlocks.get(event.index);
            if (block) block.jsonParts.push(event.delta.partial_json);
          }
        } else if (event.type === 'content_block_stop') {
          const block = toolBlocks.get(event.index);
          if (block) {
            const rawJson = block.jsonParts.join('');
            let parsed: Record<string, unknown> = {};
            try {
              parsed = JSON.parse(rawJson) as Record<string, unknown>;
            } catch {
              parsed = { _raw: rawJson };
            }
            yield {
              type: 'tool_use',
              data: { id: block.id, name: block.name, arguments: parsed },
            };
            toolBlocks.delete(event.index);
          }
        } else if (event.type === 'message_delta' && event.usage) {
          yield {
            type: 'usage',
            data: {
              prompt_tokens: 0,
              completion_tokens: event.usage.output_tokens,
            },
          };
        } else if (event.type === 'message_start' && event.message.usage) {
          yield {
            type: 'usage',
            data: {
              prompt_tokens: event.message.usage.input_tokens,
              completion_tokens: event.message.usage.output_tokens,
            },
          };
        }
      }

      yield { type: 'done' };
    } catch (err) {
      yield { type: 'error', data: { message: getErrorMessage(err) } };
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    return [];
  }

  private buildAnthropicMessages(request: AgentRequest): Anthropic.MessageParam[] {
    if (typeof request.input === 'string') {
      return [{ role: 'user', content: request.input }];
    }

    return request.input
      .filter((msg) => msg.role !== 'system')
      .map((msg) => ({
        role: msg.role as 'user' | 'assistant',
        content:
          typeof msg.content === 'string'
            ? msg.content
            : msg.content
                .filter((b) => b.type === 'text' && b.text)
                .map((b) => b.text!)
                .join('\n'),
      }));
  }
}
