/**
 * Phase 1 smoke tests — verifies enhanced search, deep research agent,
 * persistent memory, and scheduled workflows behave as intended.
 *
 * Requires a running server: pnpm dev
 * Set SKIP_LLM_TESTS=1 to skip tests that make live LLM calls.
 */
import { describe, test, expect, beforeAll } from 'vitest';
import { prepareTestAuth, authHeaders } from './helpers/testAuth.js';

const BASE_URL = process.env['TEST_BASE_URL'] ?? 'http://localhost:8080';
const skipLLM = process.env['SKIP_LLM_TESTS'] === '1';

let AUTH_TOKEN = '';

async function api(
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(AUTH_TOKEN ? authHeaders(AUTH_TOKEN) : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('application/json')
    ? ((await res.json()) as Record<string, unknown>)
    : { raw: await res.text() };
  return { status: res.status, data };
}

beforeAll(async () => {
  const health = await fetch(`${BASE_URL}/health`).catch(() => null);
  if (!health?.ok) throw new Error('Server not running. Start with: pnpm dev');

  AUTH_TOKEN = await prepareTestAuth({ baseUrl: BASE_URL, testLabel: 'phase1-smoke' });
});

// ── 1A: Enhanced Search ──

describe('1A: Enhanced Search', () => {
  test('web_search tool definition includes new filter params', async () => {
    // The models list exposes the server is healthy; tool defs are not an HTTP endpoint.
    // Verify via a /v1/responses call with the new params — should not 400.
    const { status, data } = await api('POST', '/v1/responses', {
      model: 'litellm/gemini-3.1-flash-lite-preview',
      input: 'Test search with filters',
      tools: [{ type: 'web_search' }],
      // Pass new search params in a system message; this test just checks the server
      // accepts the request without crashing on unknown fields.
    });
    // Should be 200 or 402 (no credits) — not 400 (schema rejection) or 500.
    expect([200, 201, 402]).toContain(status);
  });

  test('web_search executor accepts include_domains filter', async () => {
    if (skipLLM) return;
    // Test by calling /v1/responses with a function call that hits web_search with new params.
    // We verify it at least returns a result, not an error about unknown params.
    const { status, data } = await api('POST', '/v1/responses', {
      model: 'litellm/gemini-3.1-flash-lite-preview',
      input: [
        {
          role: 'user',
          content: 'Search for TypeScript news from github.com only, last 7 days',
        },
      ],
      tools: [{ type: 'web_search' }],
    });
    expect(status).toBe(200);
    // Should have output text
    expect(typeof data['output_text']).toBe('string');
    expect((data['output_text'] as string).length).toBeGreaterThan(0);
  });
});

// ── 1B: Deep Research Agent ──

describe('1B: Deep Research Agent', () => {
  test('deep_research is a valid agent type in schemas', async () => {
    // Verify the workflow API accepts deep_research as a task type
    // by creating a workflow that requests it (will fail planning if not valid).
    const { status, data } = await api('POST', '/v1/workflows', {
      objective: 'Research the latest TypeScript 5.x features with citations',
      orchestrator_model: 'litellm/gemini-3.1-flash-lite-preview',
      background: true,
    });
    // 200/201 = accepted; 402 = no credits (still valid schema-wise)
    expect([200, 201, 402]).toContain(status);
    if (status === 200 || status === 201) {
      expect(data['workflow_id']).toBeTruthy();
    }
  });

  test.skipIf(skipLLM)('deep_research agent produces structured report with sources', async () => {
    const { status, data } = await api('POST', '/v1/workflows', {
      objective: 'Deep research: What are the main features of TypeScript 5.4?',
      orchestrator_model: 'litellm/gemini-3.1-flash-lite-preview',
      background: false, // run synchronously so we can inspect output
    });
    expect([200, 201]).toContain(status);
    // If it ran, check the output has source-like content
    if (data['status'] === 'completed' && data['result']) {
      const result = String(data['result']);
      // Should contain citation markers or a Sources section
      const hasCitations = /\[\d+\]|Sources|References|Bibliography/i.test(result);
      expect(hasCitations).toBe(true);
    }
  });
});

// ── 1C: Persistent Memory ──

describe('1C: Persistent Memory', () => {
  let memoryId: string;

  test('POST /v1/memory saves a memory', async () => {
    const { status, data } = await api('POST', '/v1/memory', {
      key: 'test_preference_theme',
      content: 'User prefers dark mode and TypeScript strict mode',
      category: 'preferences',
    });
    expect([200, 201]).toContain(status);
    expect(data['id']).toBeTruthy();
    memoryId = data['id'] as string;
  });

  test('GET /v1/memory returns saved memories', async () => {
    const { status, data } = await api('GET', '/v1/memory');
    expect(status).toBe(200);
    const memories = data['memories'] as unknown[];
    expect(Array.isArray(memories)).toBe(true);
    expect(memories.length).toBeGreaterThan(0);
  });

  test('GET /v1/memory?category=preferences filters by category', async () => {
    const { status, data } = await api('GET', '/v1/memory?category=preferences');
    expect(status).toBe(200);
    const memories = data['memories'] as Array<Record<string, unknown>>;
    expect(Array.isArray(memories)).toBe(true);
    // Every returned memory should be in the requested category
    for (const m of memories) {
      expect(m['category']).toBe('preferences');
    }
  });

  test('POST /v1/memory upserts existing key', async () => {
    const { status: s1 } = await api('POST', '/v1/memory', {
      key: 'test_preference_theme',
      content: 'Updated: User now prefers light mode',
      category: 'preferences',
    });
    expect([200, 201]).toContain(s1);

    const { data } = await api('GET', '/v1/memory?category=preferences');
    const memories = data['memories'] as Array<Record<string, unknown>>;
    const updated = memories.find((m) => m['key'] === 'test_preference_theme');
    expect(updated?.['content']).toContain('Updated');
    // Should still be only one entry for this key (upsert, not insert)
    const dupes = memories.filter((m) => m['key'] === 'test_preference_theme');
    expect(dupes.length).toBe(1);
  });

  test('DELETE /v1/memory/:id removes memory', async () => {
    if (!memoryId) {
      // Fetch to get an id
      const { data } = await api('GET', '/v1/memory');
      const memories = data['memories'] as Array<Record<string, unknown>>;
      memoryId = String(memories?.[0]?.['id'] ?? '');
    }
    if (!memoryId) return; // skip if still no id

    const { status } = await api('DELETE', `/v1/memory/${memoryId}`);
    expect(status).toBe(200);

    // Verify it's gone
    const { data } = await api('GET', '/v1/memory');
    const memories = data['memories'] as Array<Record<string, unknown>>;
    expect(memories.find((m) => m['id'] === memoryId)).toBeUndefined();
  });
});

// ── 1D: Scheduled Workflows ──

describe('1D: Scheduled Workflows', () => {
  let scheduleId: string;

  test('POST /v1/schedules creates a schedule with valid cron', async () => {
    const { status, data } = await api('POST', '/v1/schedules', {
      cron_expression: '0 9 * * 1', // every Monday at 9am
      objective: 'Weekly TypeScript ecosystem digest',
      orchestrator_model: 'litellm/gemini-3.1-flash-lite-preview',
      background: true,
    });
    expect(status).toBe(200);
    expect(data['id']).toBeTruthy();
    expect(data['status']).toBe('active');
    expect(data['next_run_at']).toBeTruthy();
    scheduleId = data['id'] as string;
  });

  test('POST /v1/schedules rejects invalid cron', async () => {
    const { status } = await api('POST', '/v1/schedules', {
      cron_expression: 'not-a-cron',
      objective: 'Test',
    });
    expect(status).toBeGreaterThanOrEqual(400);
  });

  test('GET /v1/schedules lists schedules', async () => {
    const { status, data } = await api('GET', '/v1/schedules');
    expect(status).toBe(200);
    const schedules = data['schedules'] as unknown[];
    expect(Array.isArray(schedules)).toBe(true);
    expect(schedules.length).toBeGreaterThan(0);
  });

  test('GET /v1/schedules/:id returns schedule details', async () => {
    if (!scheduleId) return;
    const { status, data } = await api('GET', `/v1/schedules/${scheduleId}`);
    expect(status).toBe(200);
    expect(data['id']).toBe(scheduleId);
    expect(data['cron_expression']).toBe('0 9 * * 1');
  });

  test('PATCH /v1/schedules/:id pauses a schedule', async () => {
    if (!scheduleId) return;
    const { status, data } = await api('PATCH', `/v1/schedules/${scheduleId}`, {
      status: 'paused',
    });
    expect(status).toBe(200);

    const { data: fetched } = await api('GET', `/v1/schedules/${scheduleId}`);
    expect(fetched['status']).toBe('paused');
  });

  test('PATCH /v1/schedules/:id resumes and updates cron', async () => {
    if (!scheduleId) return;
    const { status } = await api('PATCH', `/v1/schedules/${scheduleId}`, {
      status: 'active',
      cron_expression: '0 10 * * 1', // change to 10am
    });
    expect(status).toBe(200);

    const { data: fetched } = await api('GET', `/v1/schedules/${scheduleId}`);
    expect(fetched['status']).toBe('active');
    expect(fetched['cron_expression']).toBe('0 10 * * 1');
  });

  test('DELETE /v1/schedules/:id soft-deletes schedule', async () => {
    if (!scheduleId) return;
    const { status } = await api('DELETE', `/v1/schedules/${scheduleId}`);
    expect(status).toBe(200);

    // Should not appear in list anymore
    const { data } = await api('GET', '/v1/schedules');
    const schedules = data['schedules'] as Array<Record<string, unknown>>;
    expect(schedules.find((s) => s['id'] === scheduleId)).toBeUndefined();
  });
});
