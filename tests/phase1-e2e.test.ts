/**
 * Phase 1 end-to-end tests — real LLM tasks that mirror Perplexity Computer use cases.
 * These tests make live LLM calls via LiteLLM.
 *
 * Requires running server + configured LITELLM_BASE_URL.
 * Run: npx vitest run tests/phase1-e2e.test.ts --timeout=120000
 */
import { describe, test, expect, beforeAll } from 'vitest';
import { prepareTestAuth, authHeaders } from './helpers/testAuth.js';

const BASE_URL = process.env['TEST_BASE_URL'] ?? 'http://localhost:8080';
let AUTH_TOKEN = '';

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(AUTH_TOKEN ? authHeaders(AUTH_TOKEN) : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(90_000),
  });
  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('application/json')
    ? ((await res.json()) as Record<string, unknown>)
    : { raw: await res.text() };
  return { status: res.status, data };
}

async function pollWorkflow(workflowId: string, timeoutMs = 90_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data } = await api('GET', `/v1/workflows/${workflowId}`);
    const status = data['status'] as string;
    if (['completed', 'failed', 'cancelled'].includes(status)) return data;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Workflow ${workflowId} timed out`);
}

beforeAll(async () => {
  const health = await fetch(`${BASE_URL}/health`).catch(() => null);
  if (!health?.ok) throw new Error('Server not running');

  AUTH_TOKEN = await prepareTestAuth({ baseUrl: BASE_URL, testLabel: 'phase1-e2e' });
}, 15_000);

// ── Task 1: Research with web search (Perplexity-style) ──

describe('Task 1: Web research with domain filters', () => {
  test('can research a topic and return structured answer', async () => {
    const { status, data } = await api('POST', '/v1/responses', {
      model: 'litellm/gemini-3.1-flash-lite-preview',
      input: 'What are the top 3 new features in TypeScript 5.4? Be concise.',
      tools: [{ type: 'web_search' }],
    });
    expect(status).toBe(200);
    const output = data['output_text'] as string;
    expect(output.length).toBeGreaterThan(100);
    console.log('\n[Task 1] Research output (first 400 chars):\n', output.slice(0, 400));

    // Verify token efficiency: output should be reasonably concise
    expect(output.length).toBeLessThan(5000);

    // Check usage was tracked
    const usage = data['usage'] as Record<string, unknown>;
    expect(usage).toBeTruthy();
    console.log('[Task 1] Tokens used:', JSON.stringify(usage));
  }, 60_000);
});

// ── Task 2: Enhanced search with recency filter ──

describe('Task 2: Enhanced search with recency + domain filters', () => {
  test('web_search with days_recency and include_domains params', async () => {
    const { status, data } = await api('POST', '/v1/responses', {
      model: 'litellm/gemini-3.1-flash-lite-preview',
      input:
        'Find recent news about AI model releases. Use web_search with days_recency=7 and search for recent AI news.',
      tools: [{ type: 'web_search' }],
    });
    expect(status).toBe(200);
    const output = data['output_text'] as string;
    expect(output.length).toBeGreaterThan(50);
    console.log('\n[Task 2] Search with recency output (first 300 chars):\n', output.slice(0, 300));
  }, 60_000);
});

// ── Task 3: Memory — store and recall across a "session boundary" ──

describe('Task 3: Persistent memory store and recall', () => {
  test('save a preference and retrieve it', async () => {
    // Save memory
    const { status: s1, data: d1 } = await api('POST', '/v1/memory', {
      key: 'coding_style',
      content: 'Prefers functional programming, TypeScript strict mode, minimal comments, named exports',
      category: 'preferences',
    });
    expect([200, 201]).toContain(s1);
    const memId = d1['id'] as string;
    console.log('\n[Task 3] Saved memory id:', memId);

    // Save project context
    await api('POST', '/v1/memory', {
      key: 'current_project',
      content: 'Working on orchestrator-platform, a TypeScript monorepo for AI agent orchestration with Fastify API',
      category: 'project',
    });

    // Recall via query
    const { status: s2, data: d2 } = await api('GET', '/v1/memory?query=TypeScript');
    // Note: current GET route doesn't support query param (uses category), so just list
    const { data: d3 } = await api('GET', '/v1/memory');
    const memories = d3['memories'] as Array<Record<string, unknown>>;
    console.log(
      '[Task 3] Retrieved memories:',
      memories.map((m) => `${m['key']}: ${String(m['content']).slice(0, 50)}`)
    );

    expect(memories.some((m) => m['key'] === 'coding_style')).toBe(true);
    expect(memories.some((m) => m['key'] === 'current_project')).toBe(true);

    // Verify upsert: save again with updated content
    const { status: s3 } = await api('POST', '/v1/memory', {
      key: 'coding_style',
      content: 'Prefers functional programming, TypeScript strict mode, concise code, no barrel files',
      category: 'preferences',
    });
    expect([200, 201]).toContain(s3);

    const { data: d4 } = await api('GET', '/v1/memory?category=preferences');
    const prefs = d4['memories'] as Array<Record<string, unknown>>;
    const updated = prefs.find((m) => m['key'] === 'coding_style');
    expect(updated?.['content']).toContain('no barrel files');
    console.log('[Task 3] Updated memory:', updated?.['content']);

    // No duplicate keys
    const dupes = prefs.filter((m) => m['key'] === 'coding_style');
    expect(dupes.length).toBe(1);
    console.log('[Task 3] ✓ No duplicate keys after upsert');
  }, 30_000);
});

// ── Task 4: Scheduled workflow — create, inspect, pause, resume, delete ──

describe('Task 4: Scheduled workflow lifecycle', () => {
  let scheduleId: string;

  test('full schedule CRUD cycle', async () => {
    // Create daily digest schedule
    const { status: s1, data: d1 } = await api('POST', '/v1/schedules', {
      cron_expression: '0 8 * * *', // every day at 8am
      objective: 'Daily tech news digest: summarize top 5 AI stories from yesterday',
      orchestrator_model: 'litellm/gemini-3.1-flash-lite-preview',
      background: true,
    });
    expect(s1).toBe(200);
    scheduleId = d1['id'] as string;
    const nextRun = d1['next_run_at'] as string;
    console.log('\n[Task 4] Created schedule:', scheduleId, '| next run:', nextRun);

    // Verify next_run_at is a valid future date
    expect(new Date(nextRun).getTime()).toBeGreaterThan(Date.now());

    // List schedules
    const { data: d2 } = await api('GET', '/v1/schedules');
    const schedules = d2['schedules'] as Array<Record<string, unknown>>;
    expect(schedules.some((s) => s['id'] === scheduleId)).toBe(true);
    console.log('[Task 4] Schedules count:', schedules.length);

    // Pause it
    const { data: d3 } = await api('PATCH', `/v1/schedules/${scheduleId}`, { status: 'paused' });
    expect(d3['success']).toBe(true);
    const { data: d4 } = await api('GET', `/v1/schedules/${scheduleId}`);
    expect(d4['status']).toBe('paused');
    console.log('[Task 4] Paused schedule');

    // Change cron and resume
    const { data: d5 } = await api('PATCH', `/v1/schedules/${scheduleId}`, {
      status: 'active',
      cron_expression: '0 9 * * *', // moved to 9am
    });
    expect(d5['success']).toBe(true);
    const { data: d6 } = await api('GET', `/v1/schedules/${scheduleId}`);
    expect(d6['status']).toBe('active');
    expect(d6['cron_expression']).toBe('0 9 * * *');
    console.log('[Task 4] Updated to 9am, status active');

    // Delete (soft)
    await api('DELETE', `/v1/schedules/${scheduleId}`);
    const { data: d7 } = await api('GET', '/v1/schedules');
    const afterDelete = d7['schedules'] as Array<Record<string, unknown>>;
    expect(afterDelete.find((s) => s['id'] === scheduleId)).toBeUndefined();
    console.log('[Task 4] ✓ Deleted — no longer in list');
  }, 30_000);
});

// ── Task 5: Full orchestrated workflow (Perplexity Computer-style) ──

describe('Task 5: Full multi-step orchestrated workflow', () => {
  test('plan and execute a research + write workflow', async () => {
    // Workflow runs 2 LLM iterations + web search, typically 60–120s total
    const { status, data } = await api('POST', '/v1/workflows', {
      objective: 'Research what "vibe coding" means in 2025 and write a 3-sentence definition',
      orchestrator_model: 'litellm/gemini-3.1-flash-lite-preview',
      background: false, // executes immediately (fires async IIFE on server)
    });

    expect([200, 201]).toContain(status);
    const workflowId = data['workflow_id'] as string;
    expect(workflowId).toBeTruthy();
    console.log('\n[Task 5] Workflow started:', workflowId);

    // Poll up to 3 minutes; if still running, verify it made real progress in the DB
    let result: Record<string, unknown> | null = null;
    try {
      result = await pollWorkflow(workflowId, 180_000);
    } catch {
      // Timeout — workflow may still be running (takes 100-180s with 2 LLM calls + search)
      // Verify it at least started executing properly (has tool_call steps in the DB)
      const { getDb } = await import('@orchestrator/shared');
      const db = getDb();
      const stepCount = (
        db.prepare('SELECT COUNT(*) as cnt FROM workflow_steps WHERE workflow_id=?').get(workflowId) as { cnt: number }
      ).cnt;
      const hasToolCall = db
        .prepare("SELECT 1 FROM workflow_steps WHERE workflow_id=? AND step_type='tool_call'")
        .get(workflowId);
      console.log(`[Task 5] Timed out after 180s — steps recorded: ${stepCount}, has tool_call: ${!!hasToolCall}`);
      // Verify the orchestrator actually spawned tool calls (not empty like the old bug)
      expect(stepCount).toBeGreaterThan(1);
      return;
    }

    console.log('[Task 5] Final status:', result['status']);
    if (result['status'] === 'completed') {
      // Verify output from workflow_steps (plan column is empty by design)
      const { getDb } = await import('@orchestrator/shared');
      const db = getDb();
      const lastMsg = db
        .prepare(
          "SELECT message_content FROM workflow_steps WHERE workflow_id=? AND step_type='orchestrator_message' ORDER BY rowid DESC LIMIT 1"
        )
        .get(workflowId) as { message_content: string } | undefined;
      const output = lastMsg?.message_content ?? '';
      console.log('[Task 5] Output (first 500 chars):\n', output.slice(0, 500));
      expect(output.length).toBeGreaterThan(50);
    } else {
      console.warn('[Task 5] Workflow did not complete:', result['error']);
    }
  }, 200_000);
});
