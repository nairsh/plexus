import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('@orchestrator/model-router', async () => {
  const actual = await vi.importActual<typeof import('@orchestrator/model-router')>('@orchestrator/model-router');
  return {
    ...actual,
    routeRequest: vi.fn(),
    resolveOrchestratorModel: vi.fn((model?: string) => model ?? 'test-orchestrator-model'),
  };
});

vi.mock('../packages/orchestrator/src/agents.js', () => ({
  dispatchToAgent: vi.fn(),
}));

vi.mock('@orchestrator/billing', () => ({
  debitCredits: vi.fn(),
}));

vi.mock('@orchestrator/sandbox', () => ({
  terminateSession: vi.fn(),
}));

import { closeDb, getDb, runMigrations } from '@orchestrator/shared';
import { continueWorkflow, executeWorkflow, planWorkflow } from '@orchestrator/orchestrator';
import { routeRequest } from '@orchestrator/model-router';
import { dispatchToAgent } from '../packages/orchestrator/src/agents.js';

let tempDir: string;

const zeroCostUsage = {
  input_tokens: 1,
  output_tokens: 1,
  total_tokens: 2,
  cost: { currency: 'USD' as const, input_cost: 0, output_cost: 0, tool_calls_cost: 0, total_cost: 0 },
};

function modelResponse(outputText: string) {
  return {
    id: crypto.randomUUID(),
    model: 'test-orchestrator-model',
    status: 'completed' as const,
    output: [],
    output_text: outputText,
    usage: zeroCostUsage,
    tools: [],
    created_at: Date.now(),
    completed_at: Date.now(),
  };
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

    vi.mocked(routeRequest).mockReset();
    vi.mocked(dispatchToAgent).mockReset();
  });

  afterEach(() => {
    closeDb();
    rmSync(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  test('runs unified tool loop with todo planning and subagent execution', async () => {
    vi.mocked(routeRequest)
      .mockResolvedValueOnce(
        modelResponse(
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
      .mockResolvedValueOnce(
        modelResponse(
          JSON.stringify({
            thinking: 'Start with research and wait for it to complete.',
            tool_calls: [
              { name: 'spawn_subagent', arguments: { todo_id: 'research_constraints' } },
              { name: 'await_subagents', arguments: { todo_ids: ['research_constraints'], timeout_seconds: 5 } },
            ],
          })
        )
      )
      .mockResolvedValueOnce(
        modelResponse(
          JSON.stringify({
            thinking: 'Research is done, move to analysis.',
            tool_calls: [
              { name: 'spawn_subagent', arguments: { todo_id: 'analyze_fit' } },
              { name: 'await_subagents', arguments: { todo_ids: ['analyze_fit'], timeout_seconds: 5 } },
            ],
          })
        )
      )
      .mockResolvedValueOnce(
        modelResponse(
          JSON.stringify({
            thinking: 'Now run writing and wait for the final synthesis.',
            tool_calls: [
              { name: 'spawn_subagent', arguments: { todo_id: 'write_summary' } },
              { name: 'await_subagents', arguments: { todo_ids: ['write_summary'], timeout_seconds: 5 } },
            ],
          })
        )
      )
      .mockResolvedValueOnce(
        modelResponse('Written final answer')
      );

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

    const completedEvent = events.find((event) => event.type === 'workflow_completed');
    expect(completedEvent).toBeTruthy();
    expect((completedEvent?.data as { output?: string }).output).toBe('Written final answer');

    const db = getDb();
    const taskRows = db.prepare('SELECT id, status FROM tasks WHERE workflow_id = ? ORDER BY created_at').all(workflowId) as Array<{ id: string; status: string }>;
    expect(taskRows).toHaveLength(3);
    expect(taskRows.every((row) => row.status === 'completed')).toBe(true);

    expect(vi.mocked(routeRequest)).toHaveBeenCalledTimes(5);
    expect(vi.mocked(dispatchToAgent)).toHaveBeenCalledTimes(3);
  });

  test('allows direct final output without subagent dispatch', async () => {
    vi.mocked(routeRequest)
      .mockResolvedValueOnce(modelResponse('Direct orchestrator output'));

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
    vi.mocked(routeRequest)
      .mockResolvedValueOnce(modelResponse('First turn output'))
      .mockResolvedValueOnce(modelResponse('Second turn output'));

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
    expect(vi.mocked(routeRequest)).toHaveBeenCalledTimes(2);
  });
});
