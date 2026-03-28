/**
 * Tool call executor — dispatches tool invocations to their implementations.
 */
import { getErrorMessage, logger, registerFileInIndex } from '@orchestrator/shared';
import type { AgentRequest, OutputBlock } from '@orchestrator/shared';
import type { ToolApprovalDecision } from '@orchestrator/shared';
import { saveMemory, recallMemory } from '@orchestrator/memory';
import { searchKnowledgeForUser } from '../knowledge.js';
import {
  executeBash,
  executeEditFile,
  executeGlob,
  executeGrep,
  executeReadFile,
  executeWriteFile,
} from './fileOperations.js';
import { applySkillToRequest, getSkillById, getSkillByIdForUser } from '../skills.js';
import { fetchUrl, searchWeb } from './tavily.js';
import { getOpenTerminalSessionForChat } from './workspaceAccess.js';
import { CANONICAL_TOOL_DEFS } from './defs.js';
import { requestCommandApproval } from './approval.js';
import { getFolderApprovalReason } from './folderScope.js';
import { executeGitHubApi, executeLinearApi, executeNotionApi } from './connectorTools.js';
import type { ToolCallResult } from './defs.js';

const FILE_CONTEXT_ERROR = {
  error: 'File operations require a chat context. Please create a workflow with a chat_id.',
};

const WORKSPACE_MISSING_ERROR = {
  error: 'No active workspace found for this chat. Please initialize a sandbox session first.',
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const parseToolArgs = (rawArgs: unknown): Record<string, unknown> => {
  if (typeof rawArgs === 'string') {
    const parsed = JSON.parse(rawArgs) as unknown;
    return isRecord(parsed) ? parsed : {};
  }
  return isRecord(rawArgs) ? rawArgs : {};
};

const getTraceContext = (request: AgentRequest) => ({
  model: request.trace?.model,
  workflow_id: request.trace?.workflow_id,
  subagent_id: request.trace?.subagent_id,
});

const traceToolCall = async (request: AgentRequest, name: string, input: Record<string, unknown>): Promise<void> => {
  await request.trace?.onToolCall?.({ name, input, ...getTraceContext(request) });
};

const traceToolResult = async (
  request: AgentRequest,
  name: string,
  input: Record<string, unknown>,
  output: unknown
): Promise<void> => {
  await request.trace?.onToolResult?.({ name, input, output, ...getTraceContext(request) });
};

export const executeToolCall = async (
  name: string,
  rawArgs: unknown,
  request: AgentRequest,
  outputBlocks: OutputBlock[]
): Promise<ToolCallResult> => {
  try {
    const args = parseToolArgs(rawArgs);

    if (name === 'run_skill') {
      const skillId = typeof args['skill_id'] === 'string' ? args['skill_id'] : undefined;
      if (!skillId) {
        return { output: JSON.stringify({ error: 'skill_id is required' }), cost: 0 };
      }
      if (request.allowed_skills && !request.allowed_skills.includes(skillId)) {
        return { output: JSON.stringify({ error: 'skill not allowed' }), cost: 0 };
      }
      const skill = request.user_id ? getSkillByIdForUser(request.user_id, skillId) : getSkillById(skillId);
      if (!skill) {
        return { output: JSON.stringify({ error: 'skill not found' }), cost: 0 };
      }
      const { systemMessage } = applySkillToRequest(
        request,
        skill,
        typeof args['input'] === 'string' ? args['input'] : undefined
      );
      return { output: JSON.stringify({ status: 'activated', skill_id: skillId }), cost: 0, systemMessage };
    }

    if (name === 'web_search') {
      const input = {
        query: args['query'],
        search_depth: args['search_depth'],
        include_domains: args['include_domains'],
        exclude_domains: args['exclude_domains'],
        days_recency: args['days_recency'],
        language: args['language'],
        content_budget: args['content_budget'],
      };
      await traceToolCall(request, name, input);
      const results = await searchWeb(String(args['query'] ?? ''), {
        searchDepth: args['search_depth'] === 'advanced' ? 'advanced' : 'basic',
        includeDomains: Array.isArray(args['include_domains']) ? args['include_domains'].filter((s): s is string => typeof s === 'string') : undefined,
        excludeDomains: Array.isArray(args['exclude_domains']) ? args['exclude_domains'].filter((s): s is string => typeof s === 'string') : undefined,
        daysRecency: typeof args['days_recency'] === 'number' ? args['days_recency'] : undefined,
        language: typeof args['language'] === 'string' ? args['language'] : undefined,
        contentBudget: typeof args['content_budget'] === 'number' ? args['content_budget'] : undefined,
      });
      outputBlocks.push({ type: 'search_results', results });
      await traceToolResult(request, name, input, results);
      return { output: JSON.stringify(results), cost: CANONICAL_TOOL_DEFS.get('web_search')!.cost };
    }

    if (name === 'fetch_url') {
      const input = { url: args['url'] };
      await traceToolCall(request, name, input);
      const content = await fetchUrl(String(args['url'] ?? ''));
      outputBlocks.push({ type: 'fetch_url_results', url: args['url'], content });
      await traceToolResult(request, name, input, content);
      return { output: JSON.stringify(content), cost: CANONICAL_TOOL_DEFS.get('fetch_url')!.cost };
    }

    if (name === 'code_execution') {
      return {
        output: JSON.stringify({
          note: 'Code execution tool available via sandbox API. Use POST /v1/sandbox/sessions for standalone execution.',
          language: args['language'],
          code: args['code'],
        }),
        cost: 0,
      };
    }

    if (['file_read', 'file_write', 'file_edit', 'bash', 'grep', 'glob'].includes(name)) {
      if (!request.chat_id) {
        return { output: JSON.stringify(FILE_CONTEXT_ERROR), cost: 0 };
      }

      if (!request.user_id) {
        return {
          output: JSON.stringify({
            error: 'File operations require a user context. Please rerun with authenticated user context.',
          }),
          cost: 0,
        };
      }

      const session = await getOpenTerminalSessionForChat(request.user_id, request.chat_id);
      if (!session) {
        return { output: JSON.stringify(WORKSPACE_MISSING_ERROR), cost: 0 };
      }

      const approvalRequired = (pathValue: unknown) => {
        if (!request.working_directory || typeof pathValue !== 'string') return null;
        return getFolderApprovalReason(request.working_directory, pathValue);
      };

      const maybeRequestPathApproval = async (pathValue: unknown): Promise<ToolApprovalDecision | null> => {
        const reason = approvalRequired(pathValue);
        if (!reason) return null;
        if (!request.trace?.onToolApprovalRequest) return 'deny';
        return request.trace.onToolApprovalRequest({
          name,
          input: { path: pathValue },
          reason,
          command_key: 'folder-scope',
          model: request.trace.model,
          workflow_id: request.trace.workflow_id,
          subagent_id: request.trace.subagent_id,
        });
      };

      if (name === 'file_read') {
        const input = { filePath: args['filePath'], limit: args['limit'], offset: args['offset'] };
        await traceToolCall(request, name, input);
        const decision = await maybeRequestPathApproval(args['filePath']);
        if (decision === 'deny') {
          const denied = { error: 'Path denied by user', path: String(args['filePath'] ?? '') };
          await traceToolResult(request, name, { filePath: args['filePath'] }, denied);
          return { output: JSON.stringify(denied), cost: 0 };
        }
        const result = await executeReadFile(
          session,
          String(args['filePath'] ?? ''),
          typeof args['limit'] === 'number' ? args['limit'] : undefined,
          typeof args['offset'] === 'number' ? args['offset'] : undefined
        );
        outputBlocks.push({ type: 'file_read_result', result });
        await traceToolResult(request, name, { filePath: args['filePath'] }, result);
        return { output: JSON.stringify(result), cost: CANONICAL_TOOL_DEFS.get('file_read')!.cost };
      }

      if (name === 'file_write') {
        const input = {
          filePath: args['filePath'],
          contentLength: typeof args['content'] === 'string' ? args['content'].length : undefined,
        };
        await traceToolCall(request, name, input);
        const decision = await maybeRequestPathApproval(args['filePath']);
        if (decision === 'deny') {
          const denied = { error: 'Path denied by user', path: String(args['filePath'] ?? '') };
          await traceToolResult(request, name, { filePath: args['filePath'] }, denied);
          return { output: JSON.stringify(denied), cost: 0 };
        }
        const result = await executeWriteFile(
          session,
          String(args['filePath'] ?? ''),
          String(args['content'] ?? '')
        );
        // Register in file index for day-grouped Files page
        if (request.user_id && request.trace?.workflow_id) {
          try {
            registerFileInIndex(request.user_id, request.trace.workflow_id, String(args['filePath'] ?? ''), result.bytes_written);
          } catch { /* non-critical */ }
        }
        outputBlocks.push({ type: 'file_write_result', result });
        await traceToolResult(request, name, { filePath: args['filePath'] }, result);
        return { output: JSON.stringify(result), cost: CANONICAL_TOOL_DEFS.get('file_write')!.cost };
      }

      if (name === 'file_edit') {
        const input = {
          filePath: args['filePath'],
          oldStringLength: typeof args['oldString'] === 'string' ? args['oldString'].length : undefined,
          newStringLength: typeof args['newString'] === 'string' ? args['newString'].length : undefined,
        };
        await traceToolCall(request, name, input);
        const decision = await maybeRequestPathApproval(args['filePath']);
        if (decision === 'deny') {
          const denied = { error: 'Path denied by user', path: String(args['filePath'] ?? '') };
          await traceToolResult(request, name, { filePath: args['filePath'] }, denied);
          return { output: JSON.stringify(denied), cost: 0 };
        }
        const result = await executeEditFile(
          session,
          String(args['filePath'] ?? ''),
          String(args['oldString'] ?? ''),
          String(args['newString'] ?? '')
        );
        outputBlocks.push({ type: 'file_edit_result', result });
        await traceToolResult(request, name, { filePath: args['filePath'] }, result);
        return { output: JSON.stringify(result), cost: CANONICAL_TOOL_DEFS.get('file_edit')!.cost };
      }

      if (name === 'bash') {
        const input = { command: args['command'], timeoutSeconds: args['timeoutSeconds'] };
        await traceToolCall(request, name, input);
        const approval = await requestCommandApproval(request, String(args['command'] ?? ''));
        if (approval === 'deny') {
          const deniedResult = {
            stdout: '',
            stderr: 'Command denied by user',
            exit_code: 1,
            command: String(args['command'] ?? ''),
            interrupted: false,
          };
          outputBlocks.push({ type: 'bash_result', result: deniedResult });
          await traceToolResult(request, name, { command: args['command'] }, deniedResult);
          return { output: JSON.stringify(deniedResult), cost: 0 };
        }
        const result = await executeBash(
          session,
          String(args['command'] ?? ''),
          typeof args['timeoutSeconds'] === 'number' ? args['timeoutSeconds'] : undefined,
          request.signal
        );
        outputBlocks.push({ type: 'bash_result', result });
        await traceToolResult(request, name, { command: args['command'] }, result);
        return { output: JSON.stringify(result), cost: CANONICAL_TOOL_DEFS.get('bash')!.cost };
      }

      if (name === 'grep') {
        const input = { pattern: args['pattern'], path: args['path'], include: args['include'] };
        await traceToolCall(request, name, input);
        const decision = await maybeRequestPathApproval(args['path']);
        if (decision === 'deny') {
          const denied = { error: 'Path denied by user', path: String(args['path'] ?? '') };
          await traceToolResult(request, name, { path: args['path'] }, denied);
          return { output: JSON.stringify(denied), cost: 0 };
        }
        const result = await executeGrep(
          session,
          String(args['pattern'] ?? ''),
          typeof args['path'] === 'string' ? args['path'] : undefined,
          typeof args['include'] === 'string' ? args['include'] : undefined
        );
        outputBlocks.push({ type: 'grep_result', result });
        await traceToolResult(request, name, { pattern: args['pattern'], path: args['path'] }, result);
        return { output: JSON.stringify(result), cost: CANONICAL_TOOL_DEFS.get('grep')!.cost };
      }

      if (name === 'glob') {
        const input = { pattern: args['pattern'], path: args['path'] };
        await traceToolCall(request, name, input);
        const decision = await maybeRequestPathApproval(args['path']);
        if (decision === 'deny') {
          const denied = { error: 'Path denied by user', path: String(args['path'] ?? '') };
          await traceToolResult(request, name, input, denied);
          return { output: JSON.stringify(denied), cost: 0 };
        }
        const result = await executeGlob(
          session,
          String(args['pattern'] ?? ''),
          typeof args['path'] === 'string' ? args['path'] : undefined
        );
        outputBlocks.push({ type: 'glob_result', result });
        await traceToolResult(request, name, input, result);
        return { output: JSON.stringify(result), cost: CANONICAL_TOOL_DEFS.get('glob')!.cost };
      }
    }

    if (name === 'remember') {
      const userId = request.user_id;
      if (!userId) return { output: JSON.stringify({ error: 'user_id required for memory operations' }), cost: 0 };
      const memory = saveMemory(userId, {
        key: String(args['key'] ?? ''),
        content: String(args['content'] ?? ''),
        category: typeof args['category'] === 'string' ? args['category'] : 'general',
      });
      return { output: JSON.stringify({ saved: true, id: memory.id }), cost: 0 };
    }

    if (name === 'recall') {
      const userId = request.user_id;
      if (!userId) return { output: JSON.stringify({ error: 'user_id required for memory operations' }), cost: 0 };
      const memories = recallMemory(userId, String(args['query'] ?? ''), typeof args['limit'] === 'number' ? args['limit'] : 5);
      return { output: JSON.stringify({ memories }), cost: 0 };
    }

    if (name === 'search_knowledge') {
      const userId = request.user_id;
      if (!userId) return { output: JSON.stringify({ error: 'user_id required for knowledge search' }), cost: 0 };
      const query = String(args['query'] ?? '');
      if (!query) return { output: JSON.stringify({ error: 'query is required' }), cost: 0 };
      const limit = typeof args['limit'] === 'number' ? args['limit'] : 5;
      await traceToolCall(request, name, { query, limit });
      const matches = await searchKnowledgeForUser(userId, query, limit);
      const result = matches.map((m) => ({
        document_id: m.document_id,
        filename: m.filename,
        content: m.content,
        score: m.score,
      }));
      await traceToolResult(request, name, { query, limit }, result);
      return { output: JSON.stringify({ results: result, count: result.length }), cost: 0 };
    }

    // ── Connector tools ──
    if (name === 'github_api') {
      const userId = request.user_id;
      if (!userId) return { output: JSON.stringify({ error: 'user_id required for GitHub API' }), cost: 0 };
      await traceToolCall(request, name, args);
      const result = await executeGitHubApi(userId, args);
      await traceToolResult(request, name, args, result);
      return { output: result, cost: 0 };
    }

    if (name === 'linear_api') {
      const userId = request.user_id;
      if (!userId) return { output: JSON.stringify({ error: 'user_id required for Linear API' }), cost: 0 };
      await traceToolCall(request, name, args);
      const result = await executeLinearApi(userId, args);
      await traceToolResult(request, name, args, result);
      return { output: result, cost: 0 };
    }

    if (name === 'notion_api') {
      const userId = request.user_id;
      if (!userId) return { output: JSON.stringify({ error: 'user_id required for Notion API' }), cost: 0 };
      await traceToolCall(request, name, args);
      const result = await executeNotionApi(userId, args);
      await traceToolResult(request, name, args, result);
      return { output: result, cost: 0 };
    }

    return { output: JSON.stringify({ error: `Unknown tool: ${name}` }), cost: 0 };
  } catch (err) {
    logger.error({ name, error: getErrorMessage(err) }, 'Tool execution failed');
    return { output: JSON.stringify({ error: getErrorMessage(err) }), cost: 0 };
  }
};
