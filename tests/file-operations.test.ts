import { describe, test, expect, beforeAll, afterAll } from 'vitest';

const BASE_URL = process.env['TEST_BASE_URL'] ?? 'http://localhost:8080';
let API_KEY = '';

/**
 * Test file operation tools through orchestration
 */

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

beforeAll(async () => {
  // Verify server is running
  try {
    const res = await fetch(`${BASE_URL}/health`);
    if (!res.ok) throw new Error('Server not healthy');
  } catch {
    throw new Error('Server is not running. Start it with: pnpm dev & sleep 2 && pnpm seed');
  }

  // Get API key from env or create test key
  API_KEY = process.env['TEST_API_KEY'] || '';
  if (!API_KEY) {
    const { createHash } = await import('node:crypto');
    const { getDb, runMigrations } = await import('@orchestrator/shared');

    runMigrations();
    const db = getDb();

    const userId = crypto.randomUUID();
    const email = `test-fileops-${Date.now()}@orchestrator.local`;

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
    ).run(keyId, userId, keyHash, rawKey.substring(0, 12), 'Test FileOps Key', '["all"]');

    API_KEY = rawKey;
  }
});

describe('File Operations Tools Integration', () => {
  let chatId: string;
  let sandboxSessionId: string;

  test('Create sandbox session with chat_id for workspace', async () => {
    chatId = `test-chat-${Date.now()}`;

    const { status, data } = await api('POST', '/v1/sandbox/sessions', {
      language: 'python',
      chat_id: chatId,
    });

    expect(status).toBe(201);
    expect(data['status']).toBe('ready');
    expect(data['chat_id']).toBe(chatId);
    sandboxSessionId = data['id'] as string;
  }, 30_000);

  test('Verify workspace is accessible via OpenTerminal', async () => {
    // List files in the workspace
    const { status, data } = await api('GET', `/v1/sandbox/sessions/${sandboxSessionId}/files`);

    expect(status).toBe(200);
    expect(Array.isArray(data['files'])).toBe(true);
  });

  test('Workflow with file operations - Clone and analyze repo', async () => {
    // Skip if no LLM keys configured
    if (process.env['SKIP_LLM_TESTS'] === '1') {
      return;
    }

    const { status, data } = await api('POST', '/v1/workflows', {
      objective: `Clone a GitHub repository and list its files. Use the bash tool to run: git clone https://github.com/octocat/Hello-World.git /home/user/repo`,
      chat_id: chatId,
      tools: ['bash', 'file_read', 'glob'],
    });

    expect(status).toBe(201);
    expect(data).toHaveProperty('workflow_id');
    expect(data).toHaveProperty('task_count');

    const workflowId = data['workflow_id'] as string;
    const tasks = data['tasks'] as Array<Record<string, unknown>>;

    console.log('Workflow created:', workflowId);
    console.log('Planned tasks:', JSON.stringify(tasks, null, 2));

    // Wait a bit for execution
    await new Promise((resolve) => setTimeout(resolve, 30000));

    // Check workflow status
    const statusRes = await api('GET', `/v1/workflows/${workflowId}`);
    console.log('Workflow status:', statusRes.data['status']);

    // Get workflow trace
    const traceRes = await api('GET', `/v1/workflows/${workflowId}/trace`);
    expect(traceRes.status).toBe(200);
    expect(traceRes.data).toHaveProperty('trace');

    const trace = traceRes.data['trace'] as Array<Record<string, unknown>>;
    console.log('Trace steps:', trace.length);

    // Look for tool calls in trace
    const toolCalls = trace.filter(
      (step) => step['step_type'] === 'subagent_tool_call' || step['step_type'] === 'tool_call'
    );
    console.log('Tool calls found:', toolCalls.length);

    if (toolCalls.length > 0) {
      console.log('Tool call details:');
      toolCalls.forEach((call, i) => {
        console.log(`  ${i + 1}. ${call['tool_name']}:`, JSON.stringify(call['tool_input']));
      });
    }

    // Check if bash tool was used
    const bashCalls = toolCalls.filter((call) => call['tool_name'] === 'bash');
    expect(bashCalls.length).toBeGreaterThan(0);
  }, 120_000);

  test('Agent API with file_read tool', async () => {
    // First write a test file via sandbox
    await api('PUT', `/v1/sandbox/sessions/${sandboxSessionId}/file/test-config.json`, {
      content: '{"app": "test", "version": "1.0.0"}',
    });

    // Skip LLM test if keys not configured
    if (process.env['SKIP_LLM_TESTS'] === '1') {
      return;
    }

    const { status, data } = await api('POST', '/v1/responses', {
      model: 'openai/gpt-4o-mini',
      input: 'Read the file /home/user/test-config.json and tell me the app name and version.',
      tools: [{ type: 'file_read' }],
      chat_id: chatId,
      max_output_tokens: 200,
    });

    expect(status).toBe(200);
    expect(data['status']).toBe('completed');

    const output = data['output_text'] as string;
    console.log('Agent response:', output);

    // Should mention the app name or version from the file
    expect(output.toLowerCase()).toMatch(/test|1\.0\.0|app|version/);

    // Check output blocks for tool results
    const outputBlocks = data['output'] as Array<Record<string, unknown>>;
    const fileReadResults = outputBlocks.filter((block) => block['type'] === 'file_read_result');
    expect(fileReadResults.length).toBeGreaterThan(0);
  }, 60_000);

  test('Agent API with grep tool', async () => {
    // Write multiple files
    await api('PUT', `/v1/sandbox/sessions/${sandboxSessionId}/file/file1.txt`, {
      content: 'Hello world\nThis is a test file\nFoo bar baz',
    });

    await api('PUT', `/v1/sandbox/sessions/${sandboxSessionId}/file/file2.txt`, {
      content: 'Another file\nTest content here\nBar baz foo',
    });

    if (process.env['SKIP_LLM_TESTS'] === '1') {
      return;
    }

    const { status, data } = await api('POST', '/v1/responses', {
      model: 'openai/gpt-4o-mini',
      input: 'Search for the word "test" in all .txt files in the workspace.',
      tools: [{ type: 'grep' }],
      chat_id: chatId,
      max_output_tokens: 200,
    });

    expect(status).toBe(200);
    expect(data['status']).toBe('completed');

    const output = data['output_text'] as string;
    console.log('Grep response:', output);
  }, 60_000);

  test('Agent API with glob tool', async () => {
    if (process.env['SKIP_LLM_TESTS'] === '1') {
      return;
    }

    const { status, data } = await api('POST', '/v1/responses', {
      model: 'openai/gpt-4o-mini',
      input: 'Find all .txt files in the workspace using glob.',
      tools: [{ type: 'glob' }],
      chat_id: chatId,
      max_output_tokens: 200,
    });

    expect(status).toBe(200);
    expect(data['status']).toBe('completed');

    const output = data['output_text'] as string;
    console.log('Glob response:', output);

    // Should mention finding files
    expect(output.toLowerCase()).toMatch(/file|txt|found/);
  }, 60_000);

  afterAll(async () => {
    // Cleanup sandbox session
    if (sandboxSessionId) {
      try {
        await api('DELETE', `/v1/sandbox/sessions/${sandboxSessionId}`);
      } catch {
        // OK if already terminated
      }
    }
  });
});
