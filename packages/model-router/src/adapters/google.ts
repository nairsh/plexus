import { GoogleGenerativeAI, type GenerateContentResult, type Part } from '@google/generative-ai';
import { getErrorMessage } from '@orchestrator/shared';
import type { AgentRequest, AgentResponse, ModelInfo, OutputBlock, StreamChunk, UsageInfo } from '@orchestrator/shared';
import { BaseAdapter } from './base.js';
import { computeCost } from '../registry.js';
import { buildGoogleTools, executeToolCall } from '../tools/registry.js';

export class GoogleAdapter extends BaseAdapter {
  readonly provider = 'google';
  private client: GoogleGenerativeAI;

  constructor() {
    super();
    this.client = new GoogleGenerativeAI(process.env['GOOGLE_AI_API_KEY'] || '');
  }

  async createResponse(request: AgentRequest): Promise<AgentResponse> {
    const modelName = this.extractModelName(request.model!);
    const startTime = Date.now();
    const outputBlocks: OutputBlock[] = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let toolCallsCost = 0;

    const contents = this.buildGoogleContents(request);
    let currentContents = [...contents];
    let maxIterations = 10;

    while (maxIterations > 0) {
      maxIterations--;
      const tools = buildGoogleTools(request.tools);
      const model = this.client.getGenerativeModel({
        model: modelName,
        ...(request.instructions ? { systemInstruction: request.instructions } : {}),
        ...(tools ? { tools } : {}),
      });

      const result: GenerateContentResult = await model.generateContent(
        {
          contents: currentContents,
          generationConfig: {
            maxOutputTokens: request.max_output_tokens,
            temperature: request.temperature,
          },
        },
        {
          signal: request.signal,
        }
      );

      const response = result.response;
      const usageMeta = response.usageMetadata;
      totalInputTokens += usageMeta?.promptTokenCount ?? 0;
      totalOutputTokens += usageMeta?.candidatesTokenCount ?? 0;

      const candidate = response.candidates?.[0];
      if (!candidate) break;

      // Check for function calls
      const functionCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
      const textParts: string[] = [];

      for (const part of candidate.content?.parts ?? []) {
        if ('functionCall' in part && part.functionCall) {
          functionCalls.push({
            name: part.functionCall.name,
            args: part.functionCall.args as Record<string, unknown>,
          });
        } else if ('text' in part && part.text) {
          textParts.push(part.text);
        }
      }

      if (functionCalls.length > 0) {
        // Add model response
        currentContents.push({
          role: 'model',
          parts: candidate.content?.parts ?? [],
        });

        // Execute tools and add results
        const functionResponses: Part[] = [];
        for (const fc of functionCalls) {
          const toolResult = await executeToolCall(fc.name, fc.args, request, outputBlocks);
          toolCallsCost += toolResult.cost;
          functionResponses.push({
            functionResponse: {
              name: fc.name,
              response: { result: toolResult.output },
            },
          });
        }

        currentContents.push({
          role: 'user',
          parts: functionResponses,
        });
        continue;
      }

      // Final response
      const fullText = textParts.join('\n');
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
        .filter((b) => b['type'] === 'message')
        .map((b) => b['content'] as string)
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
    const tools = buildGoogleTools(request.tools);

    const model = this.client.getGenerativeModel({
      model: modelName,
      ...(request.instructions ? { systemInstruction: request.instructions } : {}),
      ...(tools ? { tools } : {}),
    });

    const contents = this.buildGoogleContents(request);

    try {
      const result = await model.generateContentStream(
        {
          contents,
          generationConfig: {
            maxOutputTokens: request.max_output_tokens,
            temperature: request.temperature,
          },
        },
        {
          signal: request.signal,
        }
      );

      for await (const chunk of result.stream) {
        const text = chunk.text();
        if (text) {
          yield { type: 'text_delta', text };
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

  private buildGoogleContents(request: AgentRequest): Array<{ role: string; parts: Part[] }> {
    if (typeof request.input === 'string') {
      return [{ role: 'user', parts: [{ text: request.input }] }];
    }

    return request.input
      .filter((msg) => msg.role !== 'system')
      .map((msg) => ({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [
          {
            text:
              typeof msg.content === 'string'
                ? msg.content
                : msg.content
                    .filter((b) => b.type === 'text' && b.text)
                    .map((b) => b.text!)
                    .join('\n'),
          },
        ],
      }));
  }
}
