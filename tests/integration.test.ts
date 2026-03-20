import { describe, test, expect, beforeAll, afterAll } from 'vitest';

const BASE_URL = process.env['TEST_BASE_URL'] ?? 'http://localhost:8080';
let API_KEY = '';

/**
 * These integration tests assume a running server (pnpm dev) with seeded data (pnpm seed).
 * Run: pnpm dev & sleep 2 && pnpm seed && pnpm test
 *
 * Tests that require real LLM API calls are marked and can be skipped
 * by setting SKIP_LLM_TESTS=1 in the environment.
 */

const skipLLM = process.env['SKIP_LLM_TESTS'] === '1';

async function api(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>
): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  let data: Record<string, unknown>;
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    data = (await res.json()) as Record<string, unknown>;
  } else {
    data = { raw: await res.text() };
  }

  return { status: res.status, data };
}

// ── Setup ──

beforeAll(async () => {
  // Verify server is running
  try {
    const res = await fetch(`${BASE_URL}/health`);
    if (!res.ok) throw new Error('Server not healthy');
  } catch {
    throw new Error('Server is not running. Start it with: pnpm dev & sleep 2 && pnpm seed');
  }

  // Get API key from env or create via seed-style approach
  API_KEY = process.env['TEST_API_KEY'] || '';
  if (!API_KEY) {
    // Create a test user + key directly
    const { createHash } = await import('node:crypto');
    const { getDb, runMigrations } = await import('@orchestrator/shared');

    runMigrations();
    const db = getDb();

    const userId = crypto.randomUUID();
    const email = `test-${Date.now()}@orchestrator.local`;

    db.prepare('INSERT OR IGNORE INTO users (id, email, tier, credits_balance) VALUES (?, ?, ?, ?)').run(
      userId,
      email,
      'pro',
      100.0
    );

    const rawKey = `sk-test-${crypto.randomUUID().replace(/-/g, '')}`;
    const keyHash = createHash('sha256').update(rawKey).digest('hex');
    const keyId = crypto.randomUUID();

    db.prepare(
      'INSERT INTO api_keys (id, user_id, key_hash, key_prefix, name, permissions) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(keyId, userId, keyHash, rawKey.substring(0, 12), 'Test Key', '["all"]');

    API_KEY = rawKey;
  }
});

// ── Health & Discovery ──

describe('Health & Discovery', () => {
  test('GET /health returns ok', async () => {
    const { status, data } = await api('GET', '/health');
    expect(status).toBe(200);
    expect(data['status']).toBe('ok');
    expect(data).toHaveProperty('version');
    expect(data).toHaveProperty('timestamp');
  });

  test('GET /v1/models returns model list', async () => {
    const { status, data } = await api('GET', '/v1/models');
    expect(status).toBe(200);
    expect(Array.isArray(data['models'])).toBe(true);
    const models = data['models'] as Array<Record<string, unknown>>;
    expect(models.length).toBeGreaterThan(0);

    const model = models[0]!;
    expect(model).toHaveProperty('id');
    expect(model).toHaveProperty('provider');
    expect(model).toHaveProperty('display_name');
    expect(model).toHaveProperty('cost_per_1m_input');
    expect(model).toHaveProperty('cost_per_1m_output');
  });

  test('GET /v1/presets returns preset list', async () => {
    const { status, data } = await api('GET', '/v1/presets');
    expect(status).toBe(200);
    expect(data).toHaveProperty('presets');
  });
});

// ── Authentication ──

describe('Authentication', () => {
  test('Request without auth returns 401', async () => {
    const savedKey = API_KEY;
    API_KEY = '';
    const { status, data } = await api('GET', '/v1/billing/balance');
    API_KEY = savedKey;

    expect(status).toBe(401);
    expect(data).toHaveProperty('error');
    const error = data['error'] as Record<string, unknown>;
    expect(error['type']).toBe('authentication_error');
  });

  test('Request with invalid key returns 401', async () => {
    const savedKey = API_KEY;
    API_KEY = 'sk-invalid-key';
    const { status, data } = await api('GET', '/v1/billing/balance');
    API_KEY = savedKey;

    expect(status).toBe(401);
  });

  test('Request with valid key succeeds', async () => {
    const { status } = await api('GET', '/v1/billing/balance');
    expect(status).toBe(200);
  });
});

// ── Billing ──

describe('Billing', () => {
  test('GET /v1/billing/balance returns balance info', async () => {
    const { status, data } = await api('GET', '/v1/billing/balance');
    expect(status).toBe(200);
    expect(data).toHaveProperty('credits_balance');
    expect(data).toHaveProperty('tier');
    expect(data).toHaveProperty('usage_this_period');
    expect(typeof data['credits_balance']).toBe('number');
  });

  test('POST /v1/billing/top-up adds credits', async () => {
    const before = await api('GET', '/v1/billing/balance');
    const balanceBefore = before.data['credits_balance'] as number;

    const { status, data } = await api('POST', '/v1/billing/top-up', { amount: 10 });
    expect(status).toBe(200);
    expect(data['amount_added']).toBe(10);
    expect(data['credits_balance'] as number).toBe(balanceBefore + 10);
  });

  test('GET /v1/billing/transactions returns list', async () => {
    const { status, data } = await api('GET', '/v1/billing/transactions');
    expect(status).toBe(200);
    expect(data).toHaveProperty('transactions');
    expect(Array.isArray(data['transactions'])).toBe(true);
  });

  test('GET /v1/billing/usage returns usage data', async () => {
    const { status, data } = await api('GET', '/v1/billing/usage');
    expect(status).toBe(200);
    expect(data).toHaveProperty('total_cost');
  });
});

// ── Sandbox API ──

describe('Sandbox API', () => {
  let pythonSessionId: string;
  let jsSessionId: string;

  test('POST /v1/sandbox/sessions creates Python session', async () => {
    const { status, data } = await api('POST', '/v1/sandbox/sessions', {
      language: 'python',
    });
    expect(status).toBe(201);
    expect(data['status']).toBe('ready');
    expect(data['language']).toBe('python');
    expect(data).toHaveProperty('id');
    pythonSessionId = data['id'] as string;
  });

  test('POST /v1/sandbox/sessions creates JavaScript session', async () => {
    const { status, data } = await api('POST', '/v1/sandbox/sessions', {
      language: 'javascript',
    });
    expect(status).toBe(201);
    expect(data['status']).toBe('ready');
    jsSessionId = data['id'] as string;
  });

  test('Execute Python code returns output', async () => {
    const { status, data } = await api('POST', `/v1/sandbox/sessions/${pythonSessionId}/execute`, {
      code: 'import json; print(json.dumps({"result": 42}))',
    });
    expect(status).toBe(200);
    expect(data['exit_code']).toBe(0);
    expect(JSON.parse(data['stdout'] as string)).toEqual({ result: 42 });
    expect(data).toHaveProperty('execution_time_ms');
  });

  test('Execute JavaScript code returns output', async () => {
    const { status, data } = await api('POST', `/v1/sandbox/sessions/${jsSessionId}/execute`, {
      code: 'console.log(JSON.stringify({squares: [1,4,9,16,25]}))',
    });
    expect(status).toBe(200);
    expect(data['exit_code']).toBe(0);
    expect(JSON.parse(data['stdout'] as string)).toEqual({
      squares: [1, 4, 9, 16, 25],
    });
  });

  test('Execute code that creates a file detects modified files', async () => {
    const { data } = await api('POST', `/v1/sandbox/sessions/${pythonSessionId}/execute`, {
      code: "with open('data.txt', 'w') as f: f.write('hello world')",
    });
    expect(data['exit_code']).toBe(0);
    expect((data['files_modified'] as string[]).length).toBeGreaterThan(0);
  });

  test('File write and read roundtrip works', async () => {
    // Write
    const writeRes = await api('PUT', `/v1/sandbox/sessions/${pythonSessionId}/file/roundtrip.txt`, {
      content: 'roundtrip test data',
    });
    expect(writeRes.status).toBe(200);

    // Read
    const readRes = await fetch(`${BASE_URL}/v1/sandbox/sessions/${pythonSessionId}/file/roundtrip.txt`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(readRes.status).toBe(200);
    const text = await readRes.text();
    expect(text).toBe('roundtrip test data');
  });

  test('List files returns workspace contents', async () => {
    const { status, data } = await api('GET', `/v1/sandbox/sessions/${pythonSessionId}/files`);
    expect(status).toBe(200);
    expect(Array.isArray(data['files'])).toBe(true);
    expect((data['files'] as string[]).length).toBeGreaterThan(0);
  });

  test('Session info returns correct status', async () => {
    const { status, data } = await api('GET', `/v1/sandbox/sessions/${pythonSessionId}`);
    expect(status).toBe(200);
    expect(data['status']).toBe('ready');
  });

  test('Terminate session works', async () => {
    const { status, data } = await api('DELETE', `/v1/sandbox/sessions/${pythonSessionId}`);
    expect(status).toBe(200);
    expect(data['status']).toBe('terminated');

    // Verify session is gone
    const { data: infoData } = await api('GET', `/v1/sandbox/sessions/${pythonSessionId}`);
    expect(infoData['status']).toBe('terminated');
  });

  test('Execute on terminated session returns error', async () => {
    const { status, data } = await api('POST', `/v1/sandbox/sessions/${pythonSessionId}/execute`, {
      code: 'print("should fail")',
    });
    expect(status).toBe(500);
    expect(data).toHaveProperty('error');
  });

  test('Code with non-zero exit code returns error info', async () => {
    const { data } = await api('POST', `/v1/sandbox/sessions/${jsSessionId}/execute`, { code: 'process.exit(1)' });
    expect(data['exit_code']).not.toBe(0);
  });

  // Cleanup
  afterAll(async () => {
    try {
      await api('DELETE', `/v1/sandbox/sessions/${jsSessionId}`);
    } catch {
      // OK if already terminated
    }
  });
});

// ── Concurrent Sandbox Sessions ──

describe('Concurrent Sandbox Sessions', () => {
  test('10 concurrent sessions execute without cross-contamination', async () => {
    const sessionIds: string[] = [];

    // Create 10 sessions
    const createPromises = Array.from({ length: 10 }, (_, i) =>
      api('POST', '/v1/sandbox/sessions', { language: 'python' }).then(({ data }) => {
        sessionIds.push(data['id'] as string);
        return data['id'] as string;
      })
    );
    await Promise.all(createPromises);
    expect(sessionIds.length).toBe(10);

    // Execute unique code in each session
    const executePromises = sessionIds.map((id, i) =>
      api('POST', `/v1/sandbox/sessions/${id}/execute`, {
        code: `print(f"session_{${i}}_value_{${i * 100}}")`,
      })
    );
    const results = await Promise.all(executePromises);

    // Verify each session returned its unique value
    results.forEach((result, i) => {
      expect(result.data['exit_code']).toBe(0);
      expect((result.data['stdout'] as string).trim()).toBe(`session_${i}_value_${i * 100}`);
    });

    // Cleanup
    await Promise.all(sessionIds.map((id) => api('DELETE', `/v1/sandbox/sessions/${id}`)));
  });
});

// ── Error Format ──

describe('Error Format', () => {
  test('Invalid request body returns standard error format', async () => {
    const { status, data } = await api('POST', '/v1/sandbox/sessions', {
      language: 'invalid_language',
    });
    expect(status).toBe(400);
    expect(data).toHaveProperty('error');
    const error = data['error'] as Record<string, unknown>;
    expect(error).toHaveProperty('type');
    expect(error).toHaveProperty('message');
    expect(error).toHaveProperty('code');
  });

  test('Not found session returns proper error', async () => {
    const { status, data } = await api('GET', '/v1/sandbox/sessions/nonexistent-id');
    expect(status).toBe(500);
    expect(data).toHaveProperty('error');
  });

  test('Invalid top-up returns error format', async () => {
    const { status, data } = await api('POST', '/v1/billing/top-up', {
      amount: -5,
    });
    expect(status).toBe(400);
    expect(data).toHaveProperty('error');
  });
});

// ── Agent API (requires real LLM keys) ──

describe.skipIf(skipLLM)('Agent API (real LLM calls)', () => {
  test('POST /v1/responses with OpenAI returns response', async () => {
    const { status, data } = await api('POST', '/v1/responses', {
      model: 'openai/gpt-4o-mini',
      input: 'Reply with exactly: "Hello from OpenAI"',
      max_output_tokens: 50,
    });
    expect(status).toBe(200);
    expect(data['status']).toBe('completed');
    expect(data).toHaveProperty('output_text');
    expect(data).toHaveProperty('usage');
    const usage = data['usage'] as Record<string, unknown>;
    expect(usage).toHaveProperty('total_tokens');
    const cost = usage['cost'] as Record<string, unknown>;
    expect(cost['total_cost'] as number).toBeGreaterThan(0);
  }, 30_000);

  test('POST /v1/responses with preset resolves correctly', async () => {
    const { status, data } = await api('POST', '/v1/responses', {
      preset: 'quick-answer',
      input: 'What is 2+2? Reply with just the number.',
    });
    expect(status).toBe(200);
    expect(data['status']).toBe('completed');
  }, 30_000);

  test('Agent API with web_search tool returns grounded response', async () => {
    const { status, data } = await api('POST', '/v1/responses', {
      model: 'openai/gpt-4o-mini',
      input: 'What is the current population of Switzerland?',
      tools: [{ type: 'web_search' }],
      max_output_tokens: 500,
    });
    expect(status).toBe(200);
    expect(data['status']).toBe('completed');
    const text = data['output_text'] as string;
    expect(text.length).toBeGreaterThan(0);
  }, 60_000);

  test('Credits are debited after request', async () => {
    const before = await api('GET', '/v1/billing/balance');
    const balanceBefore = before.data['credits_balance'] as number;

    await api('POST', '/v1/responses', {
      model: 'openai/gpt-4o-mini',
      input: 'Say "test"',
      max_output_tokens: 10,
    });

    const after = await api('GET', '/v1/billing/balance');
    const balanceAfter = after.data['credits_balance'] as number;

    expect(balanceAfter).toBeLessThan(balanceBefore);
  }, 30_000);
});

// ── Workflow API (requires real LLM keys) ──

describe.skipIf(skipLLM)('Workflow API (real LLM calls)', () => {
  test('POST /v1/workflows creates and starts a workflow', async () => {
    const { status, data } = await api('POST', '/v1/workflows', {
      objective: 'Calculate the first 10 Fibonacci numbers and format them as a JSON array',
    });
    expect(status).toBe(201);
    expect(data).toHaveProperty('workflow_id');
    expect(data).toHaveProperty('task_count');
    expect(Array.isArray(data['tasks'])).toBe(true);
  }, 60_000);

  test('GET /v1/workflows lists workflows', async () => {
    const { status, data } = await api('GET', '/v1/workflows');
    expect(status).toBe(200);
    expect(data).toHaveProperty('workflows');
    expect(data).toHaveProperty('total');
    expect(Array.isArray(data['workflows'])).toBe(true);
  });

  test('DELETE /v1/workflows/:id cancels a workflow', async () => {
    const createRes = await api('POST', '/v1/workflows', {
      objective: 'Test cancellation',
    });

    const workflowId = createRes.data['workflow_id'] as string;

    const { status, data } = await api('DELETE', `/v1/workflows/${workflowId}`);
    expect(status).toBe(200);
    expect(data['status']).toBe('cancelled');
  }, 60_000);
});
