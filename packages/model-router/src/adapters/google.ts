import { GoogleGenerativeAI, SchemaType, type GenerateContentResult, type Part, type FunctionDeclaration, type Tool as GoogleTool } from '@google/generative-ai';
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
} from '../tools/fileOperations.js';
import { getOpenTerminalSessionForChat } from '../tools/workspaceAccess.js';

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

    const tools = this.buildGoogleTools(request.tools);
    const model = this.client.getGenerativeModel({
      model: modelName,
      ...(request.instructions
        ? { systemInstruction: request.instructions }
        : {}),
      ...(tools ? { tools } : {}),
    });

    const contents = this.buildGoogleContents(request);
    let currentContents = [...contents];
    let maxIterations = 10;

    while (maxIterations > 0) {
      maxIterations--;

      const result: GenerateContentResult = await model.generateContent({
        contents: currentContents,
        generationConfig: {
          maxOutputTokens: request.max_output_tokens,
          temperature: request.temperature,
        },
      });

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
          const toolResult = await this.executeTool(
            fc.name,
            fc.args,
            request,
            outputBlocks
          );
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
    const tools = this.buildGoogleTools(request.tools);

    const model = this.client.getGenerativeModel({
      model: modelName,
      ...(request.instructions
        ? { systemInstruction: request.instructions }
        : {}),
      ...(tools ? { tools } : {}),
    });

    const contents = this.buildGoogleContents(request);

    try {
      const result = await model.generateContentStream({
        contents,
        generationConfig: {
          maxOutputTokens: request.max_output_tokens,
          temperature: request.temperature,
        },
      });

      for await (const chunk of result.stream) {
        const text = chunk.text();
        if (text) {
          yield { type: 'text_delta', text };
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

  private buildGoogleContents(
    request: AgentRequest
  ): Array<{ role: string; parts: Part[] }> {
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

  private buildGoogleTools(
    tools?: Tool[]
  ): GoogleTool[] | undefined {
    if (!tools || tools.length === 0) return undefined;

    const declarations: FunctionDeclaration[] = [];

    for (const tool of tools) {
      if (tool.type === 'web_search') {
        declarations.push({
          name: 'web_search',
          description: 'Search the web for current information on a topic',
          parameters: {
            type: SchemaType.OBJECT,
            properties: {
              query: { type: SchemaType.STRING, description: 'The search query' },
            },
            required: ['query'],
          },
        });
      } else if (tool.type === 'fetch_url') {
        declarations.push({
          name: 'fetch_url',
          description: 'Fetch the content of a URL and return it as markdown',
          parameters: {
            type: SchemaType.OBJECT,
            properties: {
              url: { type: SchemaType.STRING, description: 'The URL to fetch' },
            },
            required: ['url'],
          },
        });
      } else if (tool.type === 'code_execution') {
        declarations.push({
          name: 'code_execution',
          description: 'Execute code in a sandboxed environment',
          parameters: {
            type: SchemaType.OBJECT,
            properties: {
              language: {
                type: SchemaType.STRING,
                description: 'Programming language (python or javascript)',
              },
              code: { type: SchemaType.STRING, description: 'The code to execute' },
            },
            required: ['language', 'code'],
          },
        });
      } else if (tool.type === 'file_read') {
        declarations.push({
          name: 'file_read',
          description: 'Read the contents of a file or list directory contents',
          parameters: {
            type: SchemaType.OBJECT,
            properties: {
              filePath: { type: SchemaType.STRING, description: 'Absolute path to the file or directory' },
              limit: { type: SchemaType.NUMBER, description: 'Maximum lines to read' },
              offset: { type: SchemaType.NUMBER, description: 'Line to start from (1-indexed)' },
            },
            required: ['filePath'],
          },
        });
      } else if (tool.type === 'file_write') {
        declarations.push({
          name: 'file_write',
          description: 'Write content to a file',
          parameters: {
            type: SchemaType.OBJECT,
            properties: {
              filePath: { type: SchemaType.STRING, description: 'Absolute path to the file' },
              content: { type: SchemaType.STRING, description: 'Content to write' },
            },
            required: ['filePath', 'content'],
          },
        });
      } else if (tool.type === 'file_edit') {
        declarations.push({
          name: 'file_edit',
          description: 'Edit a file by replacing old string with new string',
          parameters: {
            type: SchemaType.OBJECT,
            properties: {
              filePath: { type: SchemaType.STRING, description: 'Absolute path to the file' },
              oldString: { type: SchemaType.STRING, description: 'String to replace' },
              newString: { type: SchemaType.STRING, description: 'Replacement string' },
            },
            required: ['filePath', 'oldString', 'newString'],
          },
        });
      } else if (tool.type === 'bash') {
        declarations.push({
          name: 'bash',
          description: 'Execute bash commands for git operations and file manipulation',
          parameters: {
            type: SchemaType.OBJECT,
            properties: {
              command: { type: SchemaType.STRING, description: 'Bash command to execute' },
              timeoutSeconds: { type: SchemaType.NUMBER, description: 'Timeout in seconds' },
            },
            required: ['command'],
          },
        });
      } else if (tool.type === 'grep') {
        declarations.push({
          name: 'grep',
          description: 'Search file contents for a pattern',
          parameters: {
            type: SchemaType.OBJECT,
            properties: {
              pattern: { type: SchemaType.STRING, description: 'Search pattern' },
              path: { type: SchemaType.STRING, description: 'Directory or file to search' },
              include: { type: SchemaType.STRING, description: 'File pattern like *.ts' },
            },
            required: ['pattern'],
          },
        });
      } else if (tool.type === 'glob') {
        declarations.push({
          name: 'glob',
          description: 'Find files matching a glob pattern',
          parameters: {
            type: SchemaType.OBJECT,
            properties: {
              pattern: { type: SchemaType.STRING, description: 'Glob pattern like **/*.ts' },
              path: { type: SchemaType.STRING, description: 'Directory to search' },
            },
            required: ['pattern'],
          },
        });
      } else if (tool.type === 'function' && tool.function) {
        declarations.push({
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters as FunctionDeclaration['parameters'],
        });
      }
    }

    return declarations.length > 0
      ? [{ functionDeclarations: declarations }]
      : undefined;
  }

  private async executeTool(
    name: string,
    args: Record<string, unknown>,
    request: AgentRequest,
    outputBlocks: OutputBlock[]
  ): Promise<{ output: string; cost: number }> {
    try {
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
            input: { filePath: args['filePath'], limit: args['limit'], offset: args['offset'] },
            model: request.trace.model,
            workflow_id: request.trace.workflow_id,
            subagent_id: request.trace.subagent_id,
          });
          const result = await executeReadFile(session, args['filePath'] as string, args['limit'] as number | undefined, args['offset'] as number | undefined);
          outputBlocks.push({ type: 'file_read_result', result });
          await request.trace?.onToolResult?.({
            name,
            input: { filePath: args['filePath'] },
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
            input: { filePath: args['filePath'], contentLength: (args['content'] as string)?.length },
            model: request.trace.model,
            workflow_id: request.trace.workflow_id,
            subagent_id: request.trace.subagent_id,
          });
          const result = await executeWriteFile(session, args['filePath'] as string, args['content'] as string);
          outputBlocks.push({ type: 'file_write_result', result });
          await request.trace?.onToolResult?.({
            name,
            input: { filePath: args['filePath'] },
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
            input: { filePath: args['filePath'], oldStringLength: (args['oldString'] as string)?.length, newStringLength: (args['newString'] as string)?.length },
            model: request.trace.model,
            workflow_id: request.trace.workflow_id,
            subagent_id: request.trace.subagent_id,
          });
          const result = await executeEditFile(session, args['filePath'] as string, args['oldString'] as string, args['newString'] as string);
          outputBlocks.push({ type: 'file_edit_result', result });
          await request.trace?.onToolResult?.({
            name,
            input: { filePath: args['filePath'] },
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
            input: { command: args['command'], timeoutSeconds: args['timeoutSeconds'] },
            model: request.trace.model,
            workflow_id: request.trace.workflow_id,
            subagent_id: request.trace.subagent_id,
          });
          const result = await executeBash(session, args['command'] as string, args['timeoutSeconds'] as number | undefined);
          outputBlocks.push({ type: 'bash_result', result });
          await request.trace?.onToolResult?.({
            name,
            input: { command: args['command'] },
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
            input: { pattern: args['pattern'], path: args['path'], include: args['include'] },
            model: request.trace.model,
            workflow_id: request.trace.workflow_id,
            subagent_id: request.trace.subagent_id,
          });
          const result = await executeGrep(session, args['pattern'] as string, args['path'] as string | undefined, args['include'] as string | undefined);
          outputBlocks.push({ type: 'grep_result', result });
          await request.trace?.onToolResult?.({
            name,
            input: { pattern: args['pattern'], path: args['path'] },
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
            input: { pattern: args['pattern'], path: args['path'] },
            model: request.trace.model,
            workflow_id: request.trace.workflow_id,
            subagent_id: request.trace.subagent_id,
          });
          const result = await executeGlob(session, args['pattern'] as string, args['path'] as string | undefined);
          outputBlocks.push({ type: 'glob_result', result });
          await request.trace?.onToolResult?.({
            name,
            input: { pattern: args['pattern'], path: args['path'] },
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
