import Anthropic from '@anthropic-ai/sdk';
import { logger } from '@orchestrator/shared';
import type {
  AgentRequest,
  AgentResponse,
  ModelInfo,
  OutputBlock,
  StreamChunk,
  Tool,
  UsageInfo,
} from '@orchestrator/shared';
import { BaseAdapter } from './base.js';
import { computeCost } from '../registry.js';
import { executeWebSearch } from '../tools/webSearch.js';
import { executeFetchUrl } from '../tools/fetchUrl.js';

export class AnthropicAdapter extends BaseAdapter {
  readonly provider = 'anthropic';
  private client: Anthropic;

  constructor() {
    super();
    this.client = new Anthropic({
      apiKey: process.env['ANTHROPIC_API_KEY'],
      timeout: 120_000,
    });
  }

  async createResponse(request: AgentRequest): Promise<AgentResponse> {
    const modelName = this.extractModelName(request.model!);
    const messages = this.buildAnthropicMessages(request);
    const system = request.instructions || undefined;
    const tools = this.buildAnthropicTools(request.tools);
    const startTime = Date.now();
    const outputBlocks: OutputBlock[] = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let toolCallsCost = 0;

    let currentMessages = [...messages];
    let maxIterations = 10;

    while (maxIterations > 0) {
      maxIterations--;

      const params: Anthropic.MessageCreateParamsNonStreaming = {
        model: modelName,
        max_tokens: request.max_output_tokens ?? 8192,
        messages: currentMessages,
        ...(system ? { system } : {}),
        ...(tools && tools.length > 0 ? { tools } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      };

      const response = await this.client.messages.create(params);

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
          const result = await this.executeTool(
            tu.name,
            tu.input,
            request,
            outputBlocks
          );
          toolCallsCost += result.cost;
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
    const messages = this.buildAnthropicMessages(request);
    const system = request.instructions || undefined;
    const tools = this.buildAnthropicTools(request.tools);

    try {
      const stream = this.client.messages.stream({
        model: modelName,
        max_tokens: request.max_output_tokens ?? 8192,
        messages,
        ...(system ? { system } : {}),
        ...(tools && tools.length > 0 ? { tools } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      });

      for await (const event of stream) {
        if (
          event.type === 'content_block_delta' &&
          event.delta.type === 'text_delta'
        ) {
          yield { type: 'text_delta', text: event.delta.text };
        }
      }

      yield { type: 'done' };
    } catch (err) {
      yield { type: 'error', data: { message: (err as Error).message } };
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    return [];
  }

  private buildAnthropicMessages(
    request: AgentRequest
  ): Anthropic.MessageParam[] {
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

  private buildAnthropicTools(tools?: Tool[]): Anthropic.Tool[] | undefined {
    if (!tools || tools.length === 0) return undefined;

    const anthropicTools: Anthropic.Tool[] = [];

    for (const tool of tools) {
      if (tool.type === 'web_search') {
        anthropicTools.push({
          name: 'web_search',
          description: 'Search the web for current information on a topic',
          input_schema: {
            type: 'object' as const,
            properties: {
              query: { type: 'string', description: 'The search query' },
            },
            required: ['query'],
          },
        });
      } else if (tool.type === 'fetch_url') {
        anthropicTools.push({
          name: 'fetch_url',
          description: 'Fetch the content of a URL and return it as markdown',
          input_schema: {
            type: 'object' as const,
            properties: {
              url: { type: 'string', description: 'The URL to fetch' },
            },
            required: ['url'],
          },
        });
      } else if (tool.type === 'code_execution') {
        anthropicTools.push({
          name: 'code_execution',
          description:
            'Execute code in a sandboxed environment. Specify the language and code.',
          input_schema: {
            type: 'object' as const,
            properties: {
              language: {
                type: 'string',
                enum: ['python', 'javascript'],
                description: 'Programming language',
              },
              code: { type: 'string', description: 'The code to execute' },
            },
            required: ['language', 'code'],
          },
        });
      } else if (tool.type === 'function' && tool.function) {
        anthropicTools.push({
          name: tool.function.name,
          description: tool.function.description,
          input_schema: {
            type: 'object' as const,
            ...(tool.function.parameters as Record<string, unknown>),
          },
        });
      }
    }

    return anthropicTools.length > 0 ? anthropicTools : undefined;
  }

  private async executeTool(
    name: string,
    input: unknown,
    request: AgentRequest,
    outputBlocks: OutputBlock[]
  ): Promise<{ output: string; cost: number }> {
    try {
      const args = input as Record<string, unknown>;

      if (name === 'web_search') {
        await request.trace?.onToolCall?.({
          name,
          input: { query: args['query'] },
          model: request.trace.model,
          workflow_id: request.trace.workflow_id,
          subagent_id: request.trace.subagent_id,
        });
        const results = await executeWebSearch(args['query'] as string);
        outputBlocks.push({ type: 'search_results', results });
        await request.trace?.onToolResult?.({
          name,
          input: { query: args['query'] },
          output: results,
          model: request.trace.model,
          workflow_id: request.trace.workflow_id,
          subagent_id: request.trace.subagent_id,
        });
        return { output: JSON.stringify(results), cost: 0.005 };
      }

      if (name === 'fetch_url') {
        await request.trace?.onToolCall?.({
          name,
          input: { url: args['url'] },
          model: request.trace.model,
          workflow_id: request.trace.workflow_id,
          subagent_id: request.trace.subagent_id,
        });
        const content = await executeFetchUrl(args['url'] as string);
        outputBlocks.push({ type: 'fetch_url_results', url: args['url'], content });
        await request.trace?.onToolResult?.({
          name,
          input: { url: args['url'] },
          output: content,
          model: request.trace.model,
          workflow_id: request.trace.workflow_id,
          subagent_id: request.trace.subagent_id,
        });
        return { output: JSON.stringify(content), cost: 0.001 };
      }

      if (name === 'code_execution') {
        return {
          output: JSON.stringify({
            note: 'Code execution available via sandbox API',
            language: args['language'],
            code: args['code'],
          }),
          cost: 0,
        };
      }

      return { output: JSON.stringify({ error: `Unknown tool: ${name}` }), cost: 0 };
    } catch (err) {
      logger.error({ name, error: (err as Error).message }, 'Tool execution failed');
      return { output: JSON.stringify({ error: (err as Error).message }), cost: 0 };
    }
  }
}
