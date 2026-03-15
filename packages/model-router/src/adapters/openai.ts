import OpenAI from 'openai';
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
import {
  executeReadFile,
  executeWriteFile,
  executeEditFile,
  executeBash,
  executeGrep,
  executeGlob,
  type FileReadResult,
  type FileWriteResult,
  type FileEditResult,
  type BashResult,
  type GrepResult,
  type GlobResult,
} from '../tools/fileOperations.js';
import { getOpenTerminalSessionForChat } from '../tools/workspaceAccess.js';

export class OpenAIAdapter extends BaseAdapter {
  readonly provider = 'openai';
  private client: OpenAI;

  constructor() {
    super();
    this.client = new OpenAI({
      apiKey: process.env['OPENAI_API_KEY'],
      timeout: 120_000,
    });
  }

  async createResponse(request: AgentRequest): Promise<AgentResponse> {
    const modelName = this.extractModelName(request.model!);
    const messages = this.buildMessages(request);
    const tools = this.buildOpenAITools(request.tools);
    const startTime = Date.now();
    const outputBlocks: OutputBlock[] = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let toolCallsCost = 0;

    // Tool use loop
    let currentMessages: OpenAI.ChatCompletionMessageParam[] = messages as OpenAI.ChatCompletionMessageParam[];
    let maxIterations = 10;

    while (maxIterations > 0) {
      maxIterations--;

      const params: OpenAI.ChatCompletionCreateParamsNonStreaming = {
        model: modelName,
        messages: currentMessages as OpenAI.ChatCompletionMessageParam[],
        max_tokens: request.max_output_tokens,
        temperature: request.temperature,
      };

      if (tools && tools.length > 0) {
        params.tools = tools;
      }

      if (request.text?.format?.type === 'json_schema' && request.text.format.json_schema) {
        params.response_format = { type: 'json_object' };
      }

      const completion = await this.client.chat.completions.create(params);
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
          const result = await this.executeTool(
            toolCall.function.name,
            toolCall.function.arguments,
            request,
            outputBlocks
          );
          toolCallsCost += result.cost;

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
      outputBlocks.push({ type: 'message', content: text });

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
        output_text: text,
        usage,
        tools: request.tools ?? [],
        created_at: startTime,
        completed_at: Date.now(),
      };
    }

    // If we exhausted iterations
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
    const messages = this.buildMessages(request);
    const tools = this.buildOpenAITools(request.tools);

    const params: OpenAI.ChatCompletionCreateParamsStreaming = {
      model: modelName,
      messages: messages as OpenAI.ChatCompletionMessageParam[],
      max_tokens: request.max_output_tokens,
      temperature: request.temperature,
      stream: true,
    };

    if (tools && tools.length > 0) {
      params.tools = tools;
    }

    try {
      const stream = await this.client.chat.completions.create(params);

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          yield { type: 'text_delta', text: delta.content };
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            yield {
              type: 'tool_use',
              data: {
                id: tc.id,
                name: tc.function?.name,
                arguments: tc.function?.arguments,
              },
            };
          }
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

  private buildOpenAITools(
    tools?: Tool[]
  ): OpenAI.ChatCompletionTool[] | undefined {
    if (!tools || tools.length === 0) return undefined;

    const openaiTools: OpenAI.ChatCompletionTool[] = [];

    for (const tool of tools) {
      if (tool.type === 'web_search') {
        openaiTools.push({
          type: 'function',
          function: {
            name: 'web_search',
            description: 'Search the web for current information on a topic',
            parameters: {
              type: 'object',
              properties: {
                query: { type: 'string', description: 'The search query' },
              },
              required: ['query'],
            },
          },
        });
      } else if (tool.type === 'fetch_url') {
        openaiTools.push({
          type: 'function',
          function: {
            name: 'fetch_url',
            description: 'Fetch the content of a URL and return it as markdown',
            parameters: {
              type: 'object',
              properties: {
                url: { type: 'string', description: 'The URL to fetch' },
              },
              required: ['url'],
            },
          },
        });
      } else if (tool.type === 'code_execution') {
        openaiTools.push({
          type: 'function',
          function: {
            name: 'code_execution',
            description:
              'Execute code in a sandboxed environment. Specify the language and code to run.',
            parameters: {
              type: 'object',
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
          },
        });
      } else if (tool.type === 'file_read') {
        openaiTools.push({
          type: 'function',
          function: {
            name: 'file_read',
            description: 'Read the contents of a file or list directory contents. Use limit/offset for large files.',
            parameters: {
              type: 'object',
              properties: {
                filePath: { type: 'string', description: 'Absolute path to the file or directory to read' },
                limit: { type: 'number', description: 'Maximum number of lines to read (optional)' },
                offset: { type: 'number', description: 'Line number to start reading from (1-indexed, optional)' },
              },
              required: ['filePath'],
            },
          },
        });
      } else if (tool.type === 'file_write') {
        openaiTools.push({
          type: 'function',
          function: {
            name: 'file_write',
            description: 'Write content to a file. Creates the file if it does not exist, overwrites if it does.',
            parameters: {
              type: 'object',
              properties: {
                filePath: { type: 'string', description: 'Absolute path to the file to write' },
                content: { type: 'string', description: 'The content to write to the file' },
              },
              required: ['filePath', 'content'],
            },
          },
        });
      } else if (tool.type === 'file_edit') {
        openaiTools.push({
          type: 'function',
          function: {
            name: 'file_edit',
            description: 'Edit a file by replacing an old string with a new string. The oldString must match exactly.',
            parameters: {
              type: 'object',
              properties: {
                filePath: { type: 'string', description: 'Absolute path to the file to edit' },
                oldString: { type: 'string', description: 'The exact string to replace' },
                newString: { type: 'string', description: 'The new string to replace it with' },
              },
              required: ['filePath', 'oldString', 'newString'],
            },
          },
        });
      } else if (tool.type === 'bash') {
        openaiTools.push({
          type: 'function',
          function: {
            name: 'bash',
            description: 'Execute a bash command in the workspace. Use for git operations, file manipulation, and system commands.',
            parameters: {
              type: 'object',
              properties: {
                command: { type: 'string', description: 'The bash command to execute' },
                timeoutSeconds: { type: 'number', description: 'Timeout in seconds (default: 60, max: 300)' },
              },
              required: ['command'],
            },
          },
        });
      } else if (tool.type === 'grep') {
        openaiTools.push({
          type: 'function',
          function: {
            name: 'grep',
            description: 'Search file contents for a pattern using grep. Returns matching lines with file paths and line numbers.',
            parameters: {
              type: 'object',
              properties: {
                pattern: { type: 'string', description: 'The search pattern (regex supported)' },
                path: { type: 'string', description: 'Directory or file path to search (default: current directory)' },
                include: { type: 'string', description: 'File pattern to include, e.g., "*.ts" (optional)' },
              },
              required: ['pattern'],
            },
          },
        });
      } else if (tool.type === 'glob') {
        openaiTools.push({
          type: 'function',
          function: {
            name: 'glob',
            description: 'Find files matching a glob pattern. Returns a list of file paths.',
            parameters: {
              type: 'object',
              properties: {
                pattern: { type: 'string', description: 'The glob pattern, e.g., "**/*.ts" or "*.json"' },
                path: { type: 'string', description: 'Directory to search in (default: current directory)' },
              },
              required: ['pattern'],
            },
          },
        });
      } else if (tool.type === 'function' && tool.function) {
        openaiTools.push({
          type: 'function',
          function: {
            name: tool.function.name,
            description: tool.function.description,
            parameters: tool.function.parameters as Record<string, unknown>,
          },
        });
      }
    }

    return openaiTools.length > 0 ? openaiTools : undefined;
  }

  private async executeTool(
    name: string,
    argsJson: string,
    request: AgentRequest,
    outputBlocks: OutputBlock[]
  ): Promise<{ output: string; cost: number }> {
    try {
      const args = JSON.parse(argsJson);

      if (name === 'web_search') {
        await request.trace?.onToolCall?.({
          name,
          input: { query: args.query },
          model: request.trace.model,
          workflow_id: request.trace.workflow_id,
          subagent_id: request.trace.subagent_id,
        });
        const results = await executeWebSearch(args.query);
        outputBlocks.push({ type: 'search_results', results });
        await request.trace?.onToolResult?.({
          name,
          input: { query: args.query },
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
          input: { url: args.url },
          model: request.trace.model,
          workflow_id: request.trace.workflow_id,
          subagent_id: request.trace.subagent_id,
        });
        const content = await executeFetchUrl(args.url);
        outputBlocks.push({ type: 'fetch_url_results', url: args.url, content });
        await request.trace?.onToolResult?.({
          name,
          input: { url: args.url },
          output: content,
          model: request.trace.model,
          workflow_id: request.trace.workflow_id,
          subagent_id: request.trace.subagent_id,
        });
        return { output: JSON.stringify(content), cost: 0.001 };
      }

      if (name === 'code_execution') {
        // Delegate to sandbox manager if available, otherwise return a message
        return {
          output: JSON.stringify({
            note: 'Code execution tool available via sandbox API. Use POST /v1/sandbox/sessions for standalone execution.',
            language: args.language,
            code: args.code,
          }),
          cost: 0,
        };
      }

      // File operations - require chat_id context for workspace access
      if (name === 'file_read' || name === 'file_write' || name === 'file_edit' || 
          name === 'bash' || name === 'grep' || name === 'glob') {
        const chatId = (request as unknown as { chat_id?: string }).chat_id;
        if (!chatId) {
          return { 
            output: JSON.stringify({ 
              error: 'File operations require a chat context. Please create a workflow with a chat_id.' 
            }), 
            cost: 0 
          };
        }

        const session = await getOpenTerminalSessionForChat(chatId);
        if (!session) {
          return { 
            output: JSON.stringify({ 
              error: 'No active workspace found for this chat. Please initialize a sandbox session first.' 
            }), 
            cost: 0 
          };
        }

        if (name === 'file_read') {
          await request.trace?.onToolCall?.({
            name,
            input: { filePath: args.filePath, limit: args.limit, offset: args.offset },
            model: request.trace.model,
            workflow_id: request.trace.workflow_id,
            subagent_id: request.trace.subagent_id,
          });
          const result = await executeReadFile(session, args.filePath, args.limit, args.offset);
          outputBlocks.push({ type: 'file_read_result', result });
          await request.trace?.onToolResult?.({
            name,
            input: { filePath: args.filePath },
            output: result,
            model: request.trace.model,
            workflow_id: request.trace.workflow_id,
            subagent_id: request.trace.subagent_id,
          });
          return { output: JSON.stringify(result), cost: 0.001 };
        }

        if (name === 'file_write') {
          await request.trace?.onToolCall?.({
            name,
            input: { filePath: args.filePath, contentLength: args.content?.length },
            model: request.trace.model,
            workflow_id: request.trace.workflow_id,
            subagent_id: request.trace.subagent_id,
          });
          const result = await executeWriteFile(session, args.filePath, args.content);
          outputBlocks.push({ type: 'file_write_result', result });
          await request.trace?.onToolResult?.({
            name,
            input: { filePath: args.filePath },
            output: result,
            model: request.trace.model,
            workflow_id: request.trace.workflow_id,
            subagent_id: request.trace.subagent_id,
          });
          return { output: JSON.stringify(result), cost: 0.001 };
        }

        if (name === 'file_edit') {
          await request.trace?.onToolCall?.({
            name,
            input: { filePath: args.filePath, oldStringLength: args.oldString?.length, newStringLength: args.newString?.length },
            model: request.trace.model,
            workflow_id: request.trace.workflow_id,
            subagent_id: request.trace.subagent_id,
          });
          const result = await executeEditFile(session, args.filePath, args.oldString, args.newString);
          outputBlocks.push({ type: 'file_edit_result', result });
          await request.trace?.onToolResult?.({
            name,
            input: { filePath: args.filePath },
            output: result,
            model: request.trace.model,
            workflow_id: request.trace.workflow_id,
            subagent_id: request.trace.subagent_id,
          });
          return { output: JSON.stringify(result), cost: 0.001 };
        }

        if (name === 'bash') {
          await request.trace?.onToolCall?.({
            name,
            input: { command: args.command, timeoutSeconds: args.timeoutSeconds },
            model: request.trace.model,
            workflow_id: request.trace.workflow_id,
            subagent_id: request.trace.subagent_id,
          });
          const result = await executeBash(session, args.command, args.timeoutSeconds);
          outputBlocks.push({ type: 'bash_result', result });
          await request.trace?.onToolResult?.({
            name,
            input: { command: args.command },
            output: result,
            model: request.trace.model,
            workflow_id: request.trace.workflow_id,
            subagent_id: request.trace.subagent_id,
          });
          return { output: JSON.stringify(result), cost: 0.001 };
        }

        if (name === 'grep') {
          await request.trace?.onToolCall?.({
            name,
            input: { pattern: args.pattern, path: args.path, include: args.include },
            model: request.trace.model,
            workflow_id: request.trace.workflow_id,
            subagent_id: request.trace.subagent_id,
          });
          const result = await executeGrep(session, args.pattern, args.path, args.include);
          outputBlocks.push({ type: 'grep_result', result });
          await request.trace?.onToolResult?.({
            name,
            input: { pattern: args.pattern, path: args.path },
            output: result,
            model: request.trace.model,
            workflow_id: request.trace.workflow_id,
            subagent_id: request.trace.subagent_id,
          });
          return { output: JSON.stringify(result), cost: 0.001 };
        }

        if (name === 'glob') {
          await request.trace?.onToolCall?.({
            name,
            input: { pattern: args.pattern, path: args.path },
            model: request.trace.model,
            workflow_id: request.trace.workflow_id,
            subagent_id: request.trace.subagent_id,
          });
          const result = await executeGlob(session, args.pattern, args.path);
          outputBlocks.push({ type: 'glob_result', result });
          await request.trace?.onToolResult?.({
            name,
            input: { pattern: args.pattern, path: args.path },
            output: result,
            model: request.trace.model,
            workflow_id: request.trace.workflow_id,
            subagent_id: request.trace.subagent_id,
          });
          return { output: JSON.stringify(result), cost: 0.001 };
        }
      }

      return { output: JSON.stringify({ error: `Unknown tool: ${name}` }), cost: 0 };
    } catch (err) {
      logger.error({ name, error: (err as Error).message }, 'Tool execution failed');
      return { output: JSON.stringify({ error: (err as Error).message }), cost: 0 };
    }
  }
}
