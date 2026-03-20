import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('@orchestrator/model-router', async () => {
  const actual = await vi.importActual<typeof import('@orchestrator/model-router')>('@orchestrator/model-router');
  return {
    ...actual,
    routeRequest: vi.fn(),
    routeStreamingRequest: vi.fn(),
    executeToolCall: vi.fn(),
    getOpenTerminalSessionForChat: vi.fn(async () => ({
      containerName: 'local-test',
      apiKey: '',
      baseUrl: '',
      workspacePath: '/tmp/workspace',
    })),
    resolveOrchestratorModel: vi.fn((model?: string) => model ?? 'test-orchestrator-model'),
    computeCost: vi.fn(() => ({ input_cost: 0, output_cost: 0, total_cost: 0 })),
  };
});

vi.mock('../packages/orchestrator/src/agents.js', () => ({
  dispatchToAgent: vi.fn(),
  getAgentModel: vi.fn((agentType: string) => `litellm/${agentType}-model`),
  terminateSession: vi.fn(),
}));

vi.mock('@orchestrator/billing', () => ({
  debitCredits: vi.fn(),
}));

vi.mock('@orchestrator/sandbox', () => ({
  createSession: vi.fn(async () => ({ id: 'session-1' })),
  terminateSession: vi.fn(),
}));

import { closeDb, getDb, runMigrations } from '@orchestrator/shared';
import { continueWorkflow, executeWorkflow, getWorkflowTrace, planWorkflow } from '@orchestrator/orchestrator';
import { executeToolCall, routeStreamingRequest } from '@orchestrator/model-router';
import { createSession } from '@orchestrator/sandbox';
import { dispatchToAgent } from '../packages/orchestrator/src/agents.js';

let tempDir: string;

const zeroCostUsage = {
  input_tokens: 1,
  output_tokens: 1,
  total_tokens: 2,
  cost: { currency: 'USD' as const, input_cost: 0, output_cost: 0, tool_calls_cost: 0, total_cost: 0 },
};

function toChunks(outputText: string) {
  return (async function* () {
    yield { type: 'text_delta' as const, text: outputText };
    yield { type: 'usage' as const, data: { prompt_tokens: 1, completion_tokens: 1 } };
    yield { type: 'done' as const };
  })();
}

describe('orchestrator behavior', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'orchestrator-behavior-'));
    process.env['DATABASE_PATH'] = join(tempDir, 'test.db');
    runMigrations();

    const db = getDb();
    db.prepare('INSERT INTO users (id, email, tier, credits_balance) VALUES (?, ?, ?, ?)').run(
      'user-1',
      'behavior@test.local',
      'pro',
      100
    );

    vi.mocked(routeStreamingRequest).mockReset();
    vi.mocked(executeToolCall).mockReset();
    vi.mocked(createSession).mockReset();
    vi.mocked(createSession).mockResolvedValue({ id: 'session-1' } as { id: string });
    vi.mocked(dispatchToAgent).mockReset();
  });

  afterEach(() => {
    closeDb();
    rmSync(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  test('runs unified tool loop with todo planning and subagent execution', async () => {
    vi.mocked(routeStreamingRequest)
      .mockReturnValueOnce(
        toChunks(
          JSON.stringify({
            thinking: 'Create the initial work breakdown and commit the plan.',
            tool_calls: [
              {
                name: 'write_todo',
                arguments: {
                  todo_id: 'research_constraints',
                  description: 'Research runtime constraints relevant to TanStack with Tauri',
                  agent_type: 'research',
                  depends_on: [],
                  output_artifact: 'research_brief',
                },
              },
              {
                name: 'write_todo',
                arguments: {
                  todo_id: 'analyze_fit',
                  description: 'Analyze whether constraints are fundamental or mostly configuration-related',
                  agent_type: 'analyze',
                  depends_on: ['research_constraints'],
                  output_artifact: 'analysis',
                },
              },
              {
                name: 'write_todo',
                arguments: {
                  todo_id: 'write_summary',
                  description: 'Write final recommendation with confidence and uncertainty',
                  agent_type: 'write',
                  depends_on: ['analyze_fit'],
                  output_artifact: 'final_output',
                },
              },
            ],
          })
        )
      )
      .mockReturnValueOnce(
        toChunks(
          JSON.stringify({
            thinking: 'Start with research and wait for it to complete.',
            tool_calls: [
              { name: 'spawn_subagent', arguments: { todo_id: 'research_constraints' } },
              { name: 'await_subagents', arguments: { todo_ids: ['research_constraints'], timeout_seconds: 5 } },
            ],
          })
        )
      )
      .mockReturnValueOnce(
        toChunks(
          JSON.stringify({
            thinking: 'Research is done, move to analysis.',
            tool_calls: [
              { name: 'spawn_subagent', arguments: { todo_id: 'analyze_fit' } },
              { name: 'await_subagents', arguments: { todo_ids: ['analyze_fit'], timeout_seconds: 5 } },
            ],
          })
        )
      )
      .mockReturnValueOnce(
        toChunks(
          JSON.stringify({
            thinking: 'Now run writing and wait for the final synthesis.',
            tool_calls: [
              { name: 'spawn_subagent', arguments: { todo_id: 'write_summary' } },
              { name: 'await_subagents', arguments: { todo_ids: ['write_summary'], timeout_seconds: 5 } },
            ],
          })
        )
      )
      .mockReturnValueOnce(toChunks('Written final answer'));

    vi.mocked(dispatchToAgent)
      .mockResolvedValueOnce({
        output: 'Research findings',
        model: 'research-model',
        usage: zeroCostUsage,
      })
      .mockResolvedValueOnce({
        output: 'Analysis findings',
        model: 'analysis-model',
        usage: zeroCostUsage,
      })
      .mockResolvedValueOnce({
        output: 'Written final answer',
        model: 'writer-model',
        usage: zeroCostUsage,
      });

    const { workflowId, tasks } = await planWorkflow('user-1', {
      objective: 'Assess whether TanStack meaningfully disadvantages Tauri applications',
      orchestrator_model: 'test-orchestrator-model',
      max_credits: 5,
    });

    expect(tasks).toHaveLength(0);

    const events: Array<{ type: string; task_id?: string; data: unknown }> = [];
    const stream = executeWorkflow(workflowId);
    for await (const event of stream) {
      events.push({ type: event.type, task_id: event.task_id, data: event.data });
    }
    await stream.done;

    const started = events.filter((event) => event.type === 'task_started');
    expect(started).toHaveLength(3);
    started.forEach((event) => {
      const data = event.data as { description: string; display_description?: string };
      expect(data.description.length).toBeGreaterThan(0);
      expect(typeof data.display_description).toBe('string');
      expect((data.display_description ?? '').length).toBeGreaterThan(0);
    });

    const added = events.filter((event) => event.type === 'task_added');
    expect(added.length).toBeGreaterThanOrEqual(3);
    added.forEach((event) => {
      const data = event.data as { description: string; display_description?: string };
      expect(data.description.length).toBeGreaterThan(0);
      expect(typeof data.display_description).toBe('string');
      expect((data.display_description ?? '').length).toBeGreaterThan(0);
    });

    const completedEvent = events.find((event) => event.type === 'workflow_completed');
    expect(completedEvent).toBeTruthy();
    expect((completedEvent?.data as { output?: string }).output).toBe('Written final answer');

    const db = getDb();
    const taskRows = db
      .prepare('SELECT id, status FROM tasks WHERE workflow_id = ? ORDER BY created_at')
      .all(workflowId) as Array<{ id: string; status: string }>;
    expect(taskRows).toHaveLength(3);
    expect(taskRows.every((row) => row.status === 'completed')).toBe(true);

    expect(vi.mocked(routeStreamingRequest)).toHaveBeenCalledTimes(5);
    expect(vi.mocked(dispatchToAgent)).toHaveBeenCalledTimes(3);
  });

  test('await_subagents returns completed subagent results without extra fetch step', async () => {
    vi.mocked(routeStreamingRequest)
      .mockReturnValueOnce(
        toChunks(
          JSON.stringify({
            thinking: 'Plan a single delegated task.',
            tool_calls: [
              {
                name: 'write_todo',
                arguments: {
                  todo_id: 'reply_hello',
                  description: 'Reply hello',
                  agent_type: 'research',
                },
              },
            ],
          })
        )
      )
      .mockReturnValueOnce(
        toChunks(
          JSON.stringify({
            thinking: 'Run the subagent and wait for the result directly.',
            tool_calls: [
              { name: 'spawn_subagent', arguments: { todo_id: 'reply_hello', description: 'Reply hello' } },
              { name: 'await_subagents', arguments: { todo_ids: ['reply_hello'], timeout_seconds: 5 } },
            ],
          })
        )
      )
      .mockReturnValueOnce(toChunks('hello'));

    vi.mocked(dispatchToAgent).mockResolvedValueOnce({
      output: 'hello',
      model: 'research-model',
      usage: zeroCostUsage,
    });

    const { workflowId } = await planWorkflow('user-1', {
      objective: 'Say hello via a delegated subagent',
      orchestrator_model: 'test-orchestrator-model',
      max_credits: 5,
    });

    const stream = executeWorkflow(workflowId);
    for await (const _event of stream) {
      // consume
    }
    await stream.done;

    expect(vi.mocked(routeStreamingRequest)).toHaveBeenCalledTimes(3);
    const thirdCallMessages = vi.mocked(routeStreamingRequest).mock.calls[2]?.[0]?.input as Array<{
      role: string;
      content: string;
    }>;
    const toolResultsMessage = thirdCallMessages.at(-1)?.content;
    expect(typeof toolResultsMessage).toBe('string');
    expect(String(toolResultsMessage)).toContain('completed_results');
    expect(String(toolResultsMessage)).toContain('Reply hello');
    expect(String(toolResultsMessage)).not.toContain('get_subagent_result');
  });

  test('orchestrator exposes web tools directly', async () => {
    vi.mocked(routeStreamingRequest)
      .mockReturnValueOnce(
        toChunks(
          JSON.stringify({
            thinking: 'Use the web search tool directly.',
            tool_calls: [{ name: 'web_search', arguments: { query: 'orchestrator platform' } }],
          })
        )
      )
      .mockReturnValueOnce(toChunks('Done'));

    vi.mocked(executeToolCall).mockImplementation(async () => ({
      output: JSON.stringify({ results: [{ title: 'Result 1' }] }),
      cost: 0,
    }));

    const { workflowId } = await planWorkflow('user-1', {
      objective: 'Search the web directly',
      orchestrator_model: 'test-orchestrator-model',
      chat_id: 'chat-1',
      max_credits: 5,
    });

    const stream = executeWorkflow(workflowId);
    for await (const _event of stream) {
      // consume
    }
    await stream.done;

    expect(vi.mocked(executeToolCall)).toHaveBeenCalledWith(
      'web_search',
      { query: 'orchestrator platform' },
      expect.objectContaining({ tools: [{ type: 'web_search' }] }),
      expect.any(Array)
    );
  });

  test('allows direct final output without subagent dispatch', async () => {
    vi.mocked(routeStreamingRequest).mockReturnValueOnce(toChunks('Direct orchestrator output'));

    const { workflowId } = await planWorkflow('user-1', {
      objective: 'Give me a short direct answer',
      orchestrator_model: 'test-orchestrator-model',
      max_credits: 5,
    });

    const events: Array<{ type: string; data: unknown }> = [];
    const stream = executeWorkflow(workflowId);
    for await (const event of stream) {
      events.push({ type: event.type, data: event.data });
    }
    await stream.done;

    const workflowCompleted = events.find((event) => event.type === 'workflow_completed');
    expect(workflowCompleted).toBeTruthy();
    expect((workflowCompleted?.data as { output?: string }).output).toBe('Direct orchestrator output');
    expect(vi.mocked(dispatchToAgent)).toHaveBeenCalledTimes(0);
  });

  test('continues same workflow id for follow-up turns', async () => {
    vi.mocked(routeStreamingRequest)
      .mockReturnValueOnce(toChunks('First turn output'))
      .mockReturnValueOnce(toChunks('Second turn output'));

    const { workflowId } = await planWorkflow('user-1', {
      objective: 'First question',
      orchestrator_model: 'test-orchestrator-model',
      max_credits: 5,
    });

    const firstStream = executeWorkflow(workflowId);
    for await (const _event of firstStream) {
      // consume
    }
    await firstStream.done;

    await continueWorkflow(workflowId, 'Follow-up question');

    const secondEvents: Array<{ type: string; data: unknown }> = [];
    const secondStream = executeWorkflow(workflowId);
    for await (const event of secondStream) {
      secondEvents.push({ type: event.type, data: event.data });
    }
    await secondStream.done;

    const completed = secondEvents.find((event) => event.type === 'workflow_completed');
    expect(completed).toBeTruthy();
    expect((completed?.data as { output?: string }).output).toBe('Second turn output');
    expect(vi.mocked(routeStreamingRequest)).toHaveBeenCalledTimes(2);
  });

  test('orchestrator can execute builtin bash tool directly', async () => {
    vi.mocked(routeStreamingRequest)
      .mockReturnValueOnce(
        toChunks(
          JSON.stringify({
            thinking: 'Run a shell command directly in the workspace.',
            tool_calls: [{ name: 'bash', arguments: { command: 'pwd' } }],
          })
        )
      )
      .mockReturnValueOnce(toChunks('Done'));

    vi.mocked(executeToolCall).mockImplementation(async (name, rawArgs, request) => {
      const input = rawArgs as Record<string, unknown>;
      await request.trace?.onToolCall?.({
        name,
        input,
        model: request.model,
        workflow_id: request.trace?.workflow_id,
        subagent_id: request.trace?.subagent_id,
      });
      const output = { stdout: '/tmp/workspace\n', stderr: '', exit_code: 0 };
      await request.trace?.onToolResult?.({
        name,
        input,
        output,
        model: request.model,
        workflow_id: request.trace?.workflow_id,
        subagent_id: request.trace?.subagent_id,
      });
      return {
        output: JSON.stringify(output),
        cost: 0,
      };
    });

    const { getOpenTerminalSessionForChat } = await import('@orchestrator/model-router');
    vi.mocked(getOpenTerminalSessionForChat).mockResolvedValueOnce(null);

    const { workflowId } = await planWorkflow('user-1', {
      objective: 'Run pwd directly',
      orchestrator_model: 'test-orchestrator-model',
      chat_id: 'chat-1',
      max_credits: 5,
    });

    const stream = executeWorkflow(workflowId);
    const events: Array<{ type: string; data: unknown }> = [];
    for await (const event of stream) {
      events.push({ type: event.type, data: event.data });
    }
    await stream.done;

    expect(vi.mocked(executeToolCall)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createSession)).toHaveBeenCalledTimes(1);
    const createSessionConfig = vi.mocked(createSession).mock.calls[0]?.[1] as Record<string, unknown>;
    expect(createSessionConfig).toMatchObject({ language: 'javascript', chat_id: 'chat-1' });
    expect(Object.prototype.hasOwnProperty.call(createSessionConfig, 'task_id')).toBe(false);
    const trace = getWorkflowTrace(workflowId);
    const bashTrace = trace.find((step) => step.step_type === 'tool_call' && step.tool_name === 'bash');
    expect(bashTrace).toBeTruthy();

    const toolCallEvents = events.filter((event) => event.type === 'tool_call');
    const toolResultEvents = events.filter((event) => event.type === 'tool_result');
    expect(toolCallEvents.length).toBeGreaterThan(0);
    expect(toolResultEvents.length).toBeGreaterThan(0);
  });
});
