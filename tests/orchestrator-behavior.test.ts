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
import { executeWorkflow, planWorkflow } from '@orchestrator/orchestrator';
import { routeRequest } from '@orchestrator/model-router';
import { dispatchToAgent } from '../packages/orchestrator/src/agents.js';

let tempDir: string;

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

  test('reuses planned write task instead of adding duplicate runtime write task', async () => {
    vi.mocked(routeRequest)
      .mockResolvedValueOnce({
        id: 'plan-1',
        model: 'test-orchestrator-model',
        status: 'completed',
        output: [],
        output_text: JSON.stringify({
          tasks: [
            {
              task_id: 'research_constraints',
              description: 'Research Tauri runtime constraints relevant to TanStack libraries',
              agent_type: 'research',
              depends_on: [],
              output_artifact: 'research_brief',
            },
            {
              task_id: 'analyze_fit',
              description: 'Analyze whether the research shows fundamental or configuration-related disadvantages',
              agent_type: 'analyze',
              depends_on: ['research_constraints'],
              output_artifact: 'analysis',
            },
            {
              task_id: 'write_summary_report',
              description: 'Write the final scoped recommendation with evidence strength and uncertainty',
              agent_type: 'write',
              depends_on: ['analyze_fit'],
              output_artifact: 'final_output',
            },
          ],
        }),
        usage: {
          input_tokens: 10,
          output_tokens: 10,
          total_tokens: 20,
          cost: { currency: 'USD', input_cost: 0, output_cost: 0, tool_calls_cost: 0, total_cost: 0 },
        },
        tools: [],
        created_at: Date.now(),
        completed_at: Date.now(),
      })
      .mockResolvedValueOnce({
        id: 'loop-1',
        model: 'test-orchestrator-model',
        status: 'completed',
        output: [],
        output_text: JSON.stringify({
          thinking: 'Research is ready to run.',
          actions: [{ type: 'dispatch', task_ids: ['research_constraints'] }],
        }),
        usage: {
          input_tokens: 5,
          output_tokens: 5,
          total_tokens: 10,
          cost: { currency: 'USD', input_cost: 0, output_cost: 0, tool_calls_cost: 0, total_cost: 0 },
        },
        tools: [],
        created_at: Date.now(),
        completed_at: Date.now(),
      })
      .mockResolvedValueOnce({
        id: 'loop-2',
        model: 'test-orchestrator-model',
        status: 'completed',
        output: [],
        output_text: JSON.stringify({
          thinking: 'Analysis is next.',
          actions: [{ type: 'dispatch', task_ids: ['analyze_fit'] }],
        }),
        usage: {
          input_tokens: 5,
          output_tokens: 5,
          total_tokens: 10,
          cost: { currency: 'USD', input_cost: 0, output_cost: 0, tool_calls_cost: 0, total_cost: 0 },
        },
        tools: [],
        created_at: Date.now(),
        completed_at: Date.now(),
      })
      .mockResolvedValueOnce({
        id: 'loop-3',
        model: 'test-orchestrator-model',
        status: 'completed',
        output: [],
        output_text: JSON.stringify({
          thinking: 'Delegate the final writing to the writer.',
          actions: [{ type: 'delegate_write', prompt: 'Use the completed analysis to write the final output.' }],
        }),
        usage: {
          input_tokens: 5,
          output_tokens: 5,
          total_tokens: 10,
          cost: { currency: 'USD', input_cost: 0, output_cost: 0, tool_calls_cost: 0, total_cost: 0 },
        },
        tools: [],
        created_at: Date.now(),
        completed_at: Date.now(),
      });

    vi.mocked(dispatchToAgent)
      .mockResolvedValueOnce({
        output: 'Research output',
        model: 'research-model',
        usage: {
          input_tokens: 20,
          output_tokens: 30,
          total_tokens: 50,
          cost: { currency: 'USD', input_cost: 0, output_cost: 0, tool_calls_cost: 0, total_cost: 0 },
        },
      })
      .mockResolvedValueOnce({
        output: 'Analysis output',
        model: 'analysis-model',
        usage: {
          input_tokens: 15,
          output_tokens: 20,
          total_tokens: 35,
          cost: { currency: 'USD', input_cost: 0, output_cost: 0, tool_calls_cost: 0, total_cost: 0 },
        },
      })
      .mockResolvedValueOnce({
        output: 'Final write output',
        model: 'writer-model',
        usage: {
          input_tokens: 50,
          output_tokens: 60,
          total_tokens: 110,
          cost: { currency: 'USD', input_cost: 0, output_cost: 0, tool_calls_cost: 0, total_cost: 0 },
        },
      });

    const { workflowId } = await planWorkflow('user-1', {
      objective: 'Research if TanStack is a disadvantage for Tauri apps',
      orchestrator_model: 'test-orchestrator-model',
      max_credits: 5,
    });

    const events = [] as Array<{ type: string; task_id?: string; data: unknown }>;
    for await (const event of executeWorkflow(workflowId)) {
      events.push({ type: event.type, task_id: event.task_id, data: event.data });
    }

    const db = getDb();
    const taskIds = (db.prepare('SELECT id FROM tasks WHERE workflow_id = ? ORDER BY created_at').all(workflowId) as Array<{ id: string }>).map(row => row.id);

    expect(taskIds).toHaveLength(3);
    expect(taskIds.some(id => id.endsWith('write_final_output'))).toBe(false);

    const writeStartedEvent = events.find(event => event.type === 'task_started' && event.task_id === `${workflowId}_write_summary_report`);
    expect(writeStartedEvent).toBeTruthy();

    const writeCompletionEvent = events.find(event => event.type === 'task_completed' && event.task_id === `${workflowId}_write_summary_report`);
    expect(writeCompletionEvent).toBeTruthy();
    expect((writeCompletionEvent?.data as { usage?: { total_tokens?: number } }).usage?.total_tokens).toBe(110);
  });

  test('skips orchestrator loop for obvious direct dispatch on simple workflow', async () => {
    vi.mocked(routeRequest).mockResolvedValueOnce({
      id: 'plan-simple',
      model: 'test-orchestrator-model',
      status: 'completed',
      output: [],
      output_text: JSON.stringify({
        tasks: [
          {
            task_id: 'research_topic',
            description: 'Research the topic from multiple angles',
            agent_type: 'research',
            depends_on: [],
            output_artifact: 'research_brief',
          },
          {
            task_id: 'analyze_topic',
            description: 'Analyze the research findings',
            agent_type: 'analyze',
            depends_on: ['research_topic'],
            output_artifact: 'analysis',
          },
          {
            task_id: 'write_topic',
            description: 'Write the final answer',
            agent_type: 'write',
            depends_on: ['analyze_topic'],
            output_artifact: 'final_output',
          },
        ],
      }),
      usage: {
        input_tokens: 5,
        output_tokens: 5,
        total_tokens: 10,
        cost: { currency: 'USD', input_cost: 0, output_cost: 0, tool_calls_cost: 0, total_cost: 0 },
      },
      tools: [],
      created_at: Date.now(),
      completed_at: Date.now(),
    });

    vi.mocked(dispatchToAgent)
      .mockResolvedValueOnce({
        output: 'Research output',
        model: 'research-model',
        usage: {
          input_tokens: 10,
          output_tokens: 10,
          total_tokens: 20,
          cost: { currency: 'USD', input_cost: 0, output_cost: 0, tool_calls_cost: 0, total_cost: 0 },
        },
      })
      .mockResolvedValueOnce({
        output: 'Analysis output',
        model: 'analysis-model',
        usage: {
          input_tokens: 10,
          output_tokens: 10,
          total_tokens: 20,
          cost: { currency: 'USD', input_cost: 0, output_cost: 0, tool_calls_cost: 0, total_cost: 0 },
        },
      })
      .mockResolvedValueOnce({
        output: 'Final output',
        model: 'writer-model',
        usage: {
          input_tokens: 10,
          output_tokens: 10,
          total_tokens: 20,
          cost: { currency: 'USD', input_cost: 0, output_cost: 0, tool_calls_cost: 0, total_cost: 0 },
        },
      });

    const { workflowId } = await planWorkflow('user-1', {
      objective: 'Simple research question',
      orchestrator_model: 'test-orchestrator-model',
      max_credits: 5,
    });

    for await (const _event of executeWorkflow(workflowId)) {
      // drain events
    }

    expect(vi.mocked(routeRequest)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dispatchToAgent)).toHaveBeenCalledTimes(3);
  });
});
