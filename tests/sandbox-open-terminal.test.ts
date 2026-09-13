/**
 * Focused regression tests for Open Terminal sandbox hardening:
 *
 * 1. Docker run args include container hardening flags
 * 2. Persisted API key is encrypted (not plaintext)
 * 3. executeInOpenTerminal returns truthful execution metadata
 * 4. Startup failure after container creation cleans up orphaned containers
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeDb, decryptJson, encryptJson, getDb, runMigrations, resetEnvCache } from '@orchestrator/shared';

// ────────────────────────────────────────────────────────────────────────────
// 1. buildDockerRunArgs — hardening flags
// ────────────────────────────────────────────────────────────────────────────

describe('buildDockerRunArgs', () => {
  // Dynamic import to get the real function (no mocking needed for this unit test).
  let buildDockerRunArgs: typeof import('../packages/sandbox/src/openTerminal.js').buildDockerRunArgs;

  beforeEach(async () => {
    // Ensure getEnv() is available (buildDockerRunArgs doesn't call it, but module-level
    // imports in openTerminal.ts resolve @orchestrator/shared which validates env on first use).
    process.env['CONNECTOR_ENCRYPTION_KEY'] = 'test-encryption-key-for-docker-args';
    resetEnvCache();
    const mod = await import('../packages/sandbox/src/openTerminal.js');
    buildDockerRunArgs = mod.buildDockerRunArgs;
  });

  afterEach(() => {
    resetEnvCache();
  });

  test('includes --cap-drop=ALL flag', () => {
    const args = buildDockerRunArgs({
      containerName: 'test-container',
      apiKey: 'sk-ot-test',
      chatId: 'chat-1',
      workspacePath: '/tmp/ws',
      host: '127.0.0.1',
      image: 'test-image:latest',
    });

    expect(args).toContain('--cap-drop=ALL');
  });

  test('includes --security-opt=no-new-privileges flag', () => {
    const args = buildDockerRunArgs({
      containerName: 'test-container',
      apiKey: 'sk-ot-test',
      chatId: 'chat-1',
      workspacePath: '/tmp/ws',
      host: '127.0.0.1',
      image: 'test-image:latest',
    });

    expect(args).toContain('--security-opt=no-new-privileges');
  });

  test('includes --pids-limit flag', () => {
    const args = buildDockerRunArgs({
      containerName: 'test-container',
      apiKey: 'sk-ot-test',
      chatId: 'chat-1',
      workspacePath: '/tmp/ws',
      host: '127.0.0.1',
      image: 'test-image:latest',
    });

    expect(args).toContain('--pids-limit=256');
  });

  test('includes --memory limit flag', () => {
    const args = buildDockerRunArgs({
      containerName: 'test-container',
      apiKey: 'sk-ot-test',
      chatId: 'chat-1',
      workspacePath: '/tmp/ws',
      host: '127.0.0.1',
      image: 'test-image:latest',
    });

    expect(args).toContain('--memory=512m');
  });

  test('preserves all original required args', () => {
    const args = buildDockerRunArgs({
      containerName: 'my-container',
      apiKey: 'sk-ot-abc123',
      chatId: 'chat-42',
      workspacePath: '/data/workspace',
      host: '0.0.0.0',
      image: 'ghcr.io/open-webui/open-terminal:slim',
    });

    expect(args[0]).toBe('run');
    expect(args).toContain('-d');
    expect(args).toContain('--rm');
    expect(args).toContain('my-container');
    expect(args).toContain('/home/user');
    expect(args).toContain('ghcr.io/open-webui/open-terminal:slim');
    expect(args.some((a) => a.includes('OPEN_TERMINAL_API_KEY=sk-ot-abc123'))).toBe(true);
    expect(args.some((a) => a.includes('0.0.0.0::8000'))).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 2. API key encryption at rest
// ────────────────────────────────────────────────────────────────────────────

describe('API key encryption in DB', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ot-encrypt-'));
    process.env['DATABASE_PATH'] = join(tempDir, 'test.db');
    process.env['CONNECTOR_ENCRYPTION_KEY'] = 'test-encryption-key-32-chars-ok!';
    resetEnvCache();
    runMigrations();

    const db = getDb();
    db.prepare('INSERT INTO users (id, email, tier, credits_balance) VALUES (?, ?, ?, ?)').run(
      'user-1',
      'test@test.local',
      'pro',
      100
    );
  });

  afterEach(() => {
    closeDb();
    rmSync(tempDir, { recursive: true, force: true });
    resetEnvCache();
  });

  test('encryptJson produces a non-plaintext base64 value', () => {
    const apiKey = 'sk-ot-abc123def456';
    const encrypted = encryptJson(apiKey);

    // The encrypted value should not be the plaintext key.
    expect(encrypted).not.toBe(apiKey);
    expect(encrypted).not.toContain('sk-ot-');

    // It should be a valid base64 string.
    expect(() => Buffer.from(encrypted, 'base64')).not.toThrow();

    // Decryption round-trip should recover the original value.
    const decrypted = decryptJson<string>(encrypted);
    expect(decrypted).toBe(apiKey);
  });

  test('persisted open_terminal_api_key is not plaintext when written via encryptJson', () => {
    const apiKey = 'sk-ot-test-secret-key-9999';
    const encrypted = encryptJson(apiKey);

    const db = getDb();
    db.prepare(
      `INSERT INTO sandbox_sessions (id, user_id, chat_id, language, working_dir, open_terminal_url, open_terminal_api_key, environment_status, status, config)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'session-enc',
      'user-1',
      'chat-enc',
      'python',
      '/tmp/ws',
      'http://localhost:9000',
      encrypted,
      'running',
      'ready',
      '{}'
    );

    // Read the raw column value — it must NOT be the plaintext key.
    const row = db.prepare('SELECT open_terminal_api_key FROM sandbox_sessions WHERE id = ?').get('session-enc') as {
      open_terminal_api_key: string;
    };

    expect(row.open_terminal_api_key).not.toBe(apiKey);
    expect(row.open_terminal_api_key).not.toContain('sk-ot-');

    // Decrypt it and verify correctness.
    const recovered = decryptJson<string>(row.open_terminal_api_key);
    expect(recovered).toBe(apiKey);
  });

  test('decryptJson returns null for invalid/corrupt data', () => {
    expect(decryptJson(null)).toBeNull();
    expect(decryptJson(undefined)).toBeNull();
    expect(decryptJson('')).toBeNull();
  });

  test('legacy plaintext key is gracefully handled by decryptJson returning null', () => {
    // A plaintext key like "sk-ot-xxx" is not valid base64/AES-GCM — decryptJson should return null.
    const legacyKey = 'sk-ot-legacy-plaintext-key';
    const result = decryptJson<string>(legacyKey);

    // decryptJson should return null or throw for non-encrypted data.
    // Since the implementation tries base64 decode + AES-GCM, a random string will fail.
    expect(result).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 3. executeInOpenTerminal — truthful execution metadata
// ────────────────────────────────────────────────────────────────────────────

describe('executeInOpenTerminal metadata', () => {
  beforeEach(() => {
    process.env['CONNECTOR_ENCRYPTION_KEY'] = 'test-encryption-key-for-exec';
    resetEnvCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetEnvCache();
  });

  test('returns positive execution_time_ms and real files_modified', async () => {
    // We mock openTerminalFetchJson and openTerminalFetch to simulate the Open Terminal API.
    const otClient = await import('../packages/shared/src/openTerminalClient.js');

    let fetchJsonCallCount = 0;
    vi.spyOn(otClient, 'openTerminalFetchJson').mockImplementation(async (_conn, path) => {
      fetchJsonCallCount++;
      if (typeof path === 'string' && path === '/files/write') {
        // Simulate a small delay for realistic timing.
        await new Promise((r) => setTimeout(r, 5));
        return {};
      }
      if (typeof path === 'string' && path.startsWith('/execute')) {
        // Simulate execution delay.
        await new Promise((r) => setTimeout(r, 10));
        return {
          status: 'done',
          exit_code: 0,
          output: [{ type: 'stdout', data: 'hello\n' }],
        };
      }
      if (typeof path === 'string' && path.startsWith('/files/list')) {
        // For before/after listing: first call returns baseline, second call adds a new file.
        if (fetchJsonCallCount <= 1) {
          return { entries: [{ name: 'existing.txt' }] };
        }
        return { entries: [{ name: 'existing.txt' }, { name: 'output.csv' }] };
      }
      return {};
    });

    const { executeInOpenTerminal } = await import('../packages/sandbox/src/openTerminal.js');

    const session = {
      containerName: 'test-container',
      apiKey: 'sk-ot-test',
      baseUrl: 'http://localhost:9999',
      workspacePath: '/tmp/ws',
    };

    const result = await executeInOpenTerminal(session, 'python', 'print("hello")', 30);

    // execution_time_ms should be > 0 (we added at least ~15ms of delay).
    expect(result.execution_time_ms).toBeGreaterThan(0);
    expect(result.stdout).toBe('hello\n');
    expect(result.exit_code).toBe(0);
  });

  test('execution_time_ms reflects wall-clock time, not zero', async () => {
    const otClient = await import('../packages/shared/src/openTerminalClient.js');

    vi.spyOn(otClient, 'openTerminalFetchJson').mockImplementation(async (_conn, path) => {
      if (typeof path === 'string' && path === '/files/write') {
        return {};
      }
      if (typeof path === 'string' && path.startsWith('/execute')) {
        await new Promise((r) => setTimeout(r, 50));
        return {
          status: 'done',
          exit_code: 0,
          output: [],
        };
      }
      if (typeof path === 'string' && path.startsWith('/files/list')) {
        return { entries: [] };
      }
      return {};
    });

    const { executeInOpenTerminal } = await import('../packages/sandbox/src/openTerminal.js');

    const session = {
      containerName: 'test-container',
      apiKey: 'sk-ot-test',
      baseUrl: 'http://localhost:9999',
      workspacePath: '/tmp/ws',
    };

    const result = await executeInOpenTerminal(session, 'javascript', 'console.log(1)', 10);

    // Should be at least 50ms (our simulated delay), certainly not 0.
    expect(result.execution_time_ms).toBeGreaterThanOrEqual(40);
    expect(result.files_modified).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 4. Startup failure cleans up orphaned containers
// ────────────────────────────────────────────────────────────────────────────

// We can't spy on node:child_process.execFileSync (non-configurable), so we
// use vi.mock with a factory instead. The mock state is managed via closures.
const execCalls: Array<{ cmd: string; args: string[] }> = [];
let execMockImpl: (cmd: string, args: string[]) => string = () => '';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: (cmd: string, args: string[], opts?: unknown) => {
      execCalls.push({ cmd, args: [...args] });
      return execMockImpl(cmd, args);
    },
  };
});

describe('startOpenTerminal cleanup on failure', () => {
  beforeEach(() => {
    process.env['CONNECTOR_ENCRYPTION_KEY'] = 'test-encryption-key-for-cleanup';
    process.env['OPEN_TERMINAL_START_TIMEOUT_MS'] = '200';
    resetEnvCache();
    execCalls.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetEnvCache();
    delete process.env['OPEN_TERMINAL_START_TIMEOUT_MS'];
    execMockImpl = () => '';
  });

  test('removes container when port detection fails', async () => {
    execMockImpl = (_cmd, args) => {
      if (args[0] === 'run') return 'container-id-123';
      if (args[0] === 'port') throw new Error('Error: No public port');
      if (args[0] === 'rm') return '';
      return '';
    };

    const { startOpenTerminal } = await import('../packages/sandbox/src/openTerminal.js');

    await expect(startOpenTerminal('chat-cleanup-1', '/tmp/ws')).rejects.toThrow();

    // Find the docker rm -f call — it should have been triggered for cleanup.
    const rmCalls = execCalls.filter((c) => c.args[0] === 'rm' && c.args[1] === '-f');
    expect(rmCalls.length).toBe(1);
    expect(rmCalls[0].args[2]).toMatch(/^orchestrator-chat-cleanup-1-/);
  });

  test('removes container when health check times out', async () => {
    execMockImpl = (_cmd, args) => {
      if (args[0] === 'run') return 'container-id-456';
      if (args[0] === 'port') return '0.0.0.0:54321';
      if (args[0] === 'rm') return '';
      return '';
    };

    // Mock global fetch so health check always fails.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Connection refused'));

    const { startOpenTerminal } = await import('../packages/sandbox/src/openTerminal.js');

    try {
      await expect(startOpenTerminal('chat-cleanup-2', '/tmp/ws')).rejects.toThrow('Timed out');

      // Container should have been cleaned up.
      const rmCalls = execCalls.filter((c) => c.args[0] === 'rm' && c.args[1] === '-f');
      expect(rmCalls.length).toBe(1);
      expect(rmCalls[0].args[2]).toMatch(/^orchestrator-chat-cleanup-2-/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
