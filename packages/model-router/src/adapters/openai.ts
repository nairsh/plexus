import OpenAI from 'openai';
import { DEFAULT_LLM_TIMEOUT_MS, MAX_TOOL_ITERATIONS, getEnv, getErrorMessage } from '@orchestrator/shared';
import type { AgentRequest, AgentResponse, ModelInfo, OutputBlock, StreamChunk } from '@orchestrator/shared';
import { BaseAdapter } from './base.js';
import {
  appendReasoningBlock,
  buildUsageInfo,
  extractReasoningText,
  OpenAIToolCallAccumulator,
} from './openai-compatible.js';
import { buildOpenAITools, executeToolCall } from '../tools/registry.js';

export class OpenAIAdapter extends BaseAdapter {
  readonly provider = 'openai';
  private client: OpenAI;

  constructor() {
    super();
    this.client = new OpenAI({
      apiKey: getEnv().OPENAI_API_KEY,
      timeout: DEFAULT_LLM_TIMEOUT_MS,
    });
  }

  async createResponse(request: AgentRequest): Promise<AgentResponse> {
    const modelName = this.extractModelName(request.model!);
    const messages = this.buildMessages(request);
    const startTime = Date.now();
    const outputBlocks: OutputBlock[] = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let toolCallsCost = 0;

    // Tool use loop
    let currentMessages: OpenAI.ChatCompletionMessageParam[] = messages as OpenAI.ChatCompletionMessageParam[];
    let maxIterations = MAX_TOOL_ITERATIONS;

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
        // Use strict json_schema mode when a schema is provided; fall back to json_object otherwise
        params.response_format = {
          type: 'json_schema',
          json_schema: {
            name: 'response',
            schema: request.text.format.json_schema as Record<string, unknown>,
            strict: true,
          },
        };
      }

      const completion = await this.client.chat.completions.create(params, {
        signal: request.signal,
      });
      const choice = completion.choices[0];

      totalInputTokens += completion.usage?.prompt_tokens ?? 0;
      totalOutputTokens += completion.usage?.completion_tokens ?? 0;

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
            completion.usage
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
        completion.usage
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
    }

    // If we exhausted iterations
    const usage = buildUsageInfo(request.model!, totalInputTokens, totalOutputTokens, toolCallsCost);
    return {
      id: this.generateId(),
      model: request.model!,
      status: 'incomplete',
      output: outputBlocks,
      output_text: outputBlocks
        .filter((b) => b['type'] === 'message')
        .map((b) => b['content'] as string)
        .join('\n'),
      usage,
      tools: request.tools ?? [],
      created_at: startTime,
      completed_at: Date.now(),
    };
  }

  async *streamResponse(request: AgentRequest): AsyncIterable<StreamChunk> {
    const modelName = this.extractModelName(request.model!);
    const messages = this.buildMessages(request);
    const tools = buildOpenAITools(request.tools);

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

      yield { type: 'done' };
    } catch (err) {
      yield { type: 'error', data: { message: getErrorMessage(err) } };
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    return [];
  }
}
