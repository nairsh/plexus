import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { closeDb, getDb, runMigrations, resetEnvCache, getStorage, resetStorageAdapter } from '@orchestrator/shared';
import { saveMemory, recallMemory, listMemories, deleteMemory } from '@orchestrator/memory';

describe('memory operations', () => {
  let tempDir = '';
  const userId = 'test-user-memory';

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'memory-test-'));
    process.env['DATABASE_PATH'] = join(tempDir, 'test.db');
    closeDb();
    resetEnvCache();
    runMigrations();

    const db = getDb();
    db.prepare('INSERT INTO users (id, email, tier, credits_balance) VALUES (?, ?, ?, ?)').run(
      userId,
      'memtest@example.test',
      'pro',
      100
    );
  });

  afterEach(() => {
    closeDb();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('saveMemory creates a new memory with relevance score', () => {
    const memory = saveMemory(userId, {
      key: 'preferred-language',
      content: 'I prefer TypeScript for all my projects because of strong typing',
      category: 'preferences',
    });

    expect(memory.id).toBeDefined();
    expect(memory.key).toBe('preferred-language');
    expect(memory.content).toContain('TypeScript');
    expect(memory.category).toBe('preferences');
    expect(memory.relevance_score).toBeGreaterThan(0);
  });

  test('saveMemory upserts existing key', () => {
    const first = saveMemory(userId, { key: 'theme', content: 'dark mode' });
    const second = saveMemory(userId, { key: 'theme', content: 'light mode with blue accents' });

    expect(second.id).toBe(first.id);
    expect(second.content).toBe('light mode with blue accents');
    expect(second.relevance_score).toBeGreaterThan(0);
  });

  test('saveMemory stores embedding when provided', () => {
    const embedding = [0.1, 0.2, 0.3];
    saveMemory(userId, {
      key: 'with-embedding',
      content: 'Memory with an embedding vector',
      embedding,
      embeddingModel: 'test-model',
    });

    const db = getDb();
    const row = db
      .prepare('SELECT embedding, embedding_model FROM user_memories WHERE key = ?')
      .get('with-embedding') as {
      embedding: string | null;
      embedding_model: string | null;
    };
    expect(row.embedding_model).toBe('test-model');
    expect(JSON.parse(row.embedding!)).toEqual([0.1, 0.2, 0.3]);
  });

  test('saveMemory upserts embedding on existing key', () => {
    saveMemory(userId, { key: 'evolving', content: 'first version' });
    saveMemory(userId, {
      key: 'evolving',
      content: 'second version with embedding',
      embedding: [1, 2, 3],
      embeddingModel: 'v2-model',
    });

    const db = getDb();
    const row = db.prepare('SELECT embedding, embedding_model FROM user_memories WHERE key = ?').get('evolving') as {
      embedding: string | null;
      embedding_model: string | null;
    };
    expect(row.embedding_model).toBe('v2-model');
    expect(JSON.parse(row.embedding!)).toEqual([1, 2, 3]);
  });

  test('recallMemory finds memories by keywords', () => {
    saveMemory(userId, { key: 'lang', content: 'I use Python for data science tasks' });
    saveMemory(userId, { key: 'editor', content: 'VS Code is my preferred editor' });

    const results = recallMemory(userId, 'What Python tools do you use?');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.content).toContain('Python');
  });

  test('recallMemory returns [] when query has only stop words and no embedding', () => {
    saveMemory(userId, { key: 'fact1', content: 'Memory alpha one' });
    saveMemory(userId, { key: 'fact2', content: 'Memory beta two' });

    const results = recallMemory(userId, 'the and or but');
    expect(results).toEqual([]);
  });

  test('recallMemory returns [] for empty string query', () => {
    saveMemory(userId, { key: 'fact1', content: 'Anything' });
    expect(recallMemory(userId, '')).toEqual([]);
    expect(recallMemory(userId, '   ')).toEqual([]);
  });

  test('recallMemory increments access_count', () => {
    saveMemory(userId, { key: 'tool', content: 'I use Docker containers extensively' });

    recallMemory(userId, 'Docker setup');
    const memories = listMemories(userId);
    const docker = memories.find((m) => m.key === 'tool');
    expect(docker!.access_count).toBe(1);
  });

  // ── Semantic recall tests ─────────────────────────────────────────────────

  test('semantic recall finds memory even when keywords differ', () => {
    // Save two memories with synthetic embeddings:
    // Memory A is semantically "close" to our query embedding.
    // Memory B is far from it.
    saveMemory(userId, {
      key: 'typescript-prefs',
      content: 'I love using TypeScript with strict null checks enabled',
      embedding: [1, 0, 0],
      embeddingModel: 'test',
    });
    saveMemory(userId, {
      key: 'cooking-hobby',
      content: 'I enjoy making pasta and Italian cuisine on weekends',
      embedding: [0, 1, 0],
      embeddingModel: 'test',
    });

    // Query with keywords that do NOT appear in Memory A's content,
    // but the embedding is very close to Memory A's.
    const queryEmbedding = [0.95, 0.05, 0];
    const results = recallMemory(userId, 'programming language preferences', 10, queryEmbedding);

    expect(results.length).toBe(1);
    expect(results[0]!.key).toBe('typescript-prefs');
  });

  test('semantic recall filters out low-similarity matches', () => {
    saveMemory(userId, {
      key: 'distant',
      content: 'Some unrelated memory content',
      embedding: [0, 0, 1],
      embeddingModel: 'test',
    });

    // Query embedding is orthogonal → similarity = 0 → below MIN_MEMORY_SIMILARITY
    const queryEmbedding = [1, 0, 0];
    const results = recallMemory(userId, 'anything', 10, queryEmbedding);
    expect(results).toEqual([]);
  });

  test('semantic recall skips memories without embeddings', () => {
    // Memory without embedding (legacy)
    saveMemory(userId, { key: 'no-vec', content: 'Legacy memory without embedding' });
    // Memory with embedding
    saveMemory(userId, {
      key: 'has-vec',
      content: 'Modern memory with embedding',
      embedding: [1, 0, 0],
      embeddingModel: 'test',
    });

    const queryEmbedding = [1, 0, 0];
    const results = recallMemory(userId, 'something', 10, queryEmbedding);

    expect(results.length).toBe(1);
    expect(results[0]!.key).toBe('has-vec');
  });

  test('semantic recall increments access_count for returned memories', () => {
    saveMemory(userId, {
      key: 'accessed',
      content: 'Track access count semantically',
      embedding: [1, 0, 0],
      embeddingModel: 'test',
    });

    recallMemory(userId, 'track', 10, [1, 0, 0]);

    const memories = listMemories(userId);
    const accessed = memories.find((m) => m.key === 'accessed');
    expect(accessed!.access_count).toBe(1);
  });

  test('semantic recall respects limit', () => {
    for (let i = 0; i < 5; i++) {
      saveMemory(userId, {
        key: `vec-${i}`,
        content: `Memory item ${i}`,
        embedding: [1, 0, 0],
        embeddingModel: 'test',
      });
    }

    const results = recallMemory(userId, 'items', 2, [1, 0, 0]);
    expect(results.length).toBe(2);
  });

  test('semantic recall ranks by similarity descending', () => {
    saveMemory(userId, {
      key: 'close',
      content: 'Very close match',
      embedding: [0.9, 0.1, 0],
      embeddingModel: 'test',
    });
    saveMemory(userId, {
      key: 'closer',
      content: 'Even closer match',
      embedding: [1, 0, 0],
      embeddingModel: 'test',
    });

    const results = recallMemory(userId, 'query', 10, [1, 0, 0]);
    expect(results.length).toBe(2);
    // Exact match (closer) should come first
    expect(results[0]!.key).toBe('closer');
    expect(results[1]!.key).toBe('close');
  });

  // ── List / delete tests ───────────────────────────────────────────────────

  test('listMemories returns all memories with default limit', () => {
    for (let i = 0; i < 5; i++) {
      saveMemory(userId, { key: `item-${i}`, content: `Content for item ${i}` });
    }
    const all = listMemories(userId);
    expect(all.length).toBe(5);
  });

  test('listMemories respects limit and offset', () => {
    for (let i = 0; i < 10; i++) {
      saveMemory(userId, { key: `page-${i}`, content: `Page content ${i}` });
    }

    const page1 = listMemories(userId, undefined, 3, 0);
    expect(page1.length).toBe(3);

    const page2 = listMemories(userId, undefined, 3, 3);
    expect(page2.length).toBe(3);

    // No overlap between pages
    const page1Keys = page1.map((m) => m.key);
    const page2Keys = page2.map((m) => m.key);
    expect(page1Keys.some((k) => page2Keys.includes(k))).toBe(false);
  });

  test('listMemories filters by category', () => {
    saveMemory(userId, { key: 'a', content: 'Pref A', category: 'preferences' });
    saveMemory(userId, { key: 'b', content: 'Fact B', category: 'facts' });
    saveMemory(userId, { key: 'c', content: 'Pref C', category: 'preferences' });

    const prefs = listMemories(userId, 'preferences');
    expect(prefs.length).toBe(2);
    expect(prefs.every((m) => m.category === 'preferences')).toBe(true);
  });

  test('deleteMemory removes the memory', () => {
    const memory = saveMemory(userId, { key: 'temp', content: 'Temporary data' });
    const deleted = deleteMemory(userId, memory.id);
    expect(deleted).toBe(true);

    const remaining = listMemories(userId);
    expect(remaining.find((m) => m.id === memory.id)).toBeUndefined();
  });

  test('deleteMemory returns false for non-existent ID', () => {
    const deleted = deleteMemory(userId, 'non-existent-id');
    expect(deleted).toBe(false);
  });

  test('relevance score increases with content richness', () => {
    const short = saveMemory(userId, { key: 'short', content: 'hi' });
    const long = saveMemory(userId, {
      key: 'long',
      content:
        'I prefer using TypeScript with strict mode enabled and React with functional components and hooks for all frontend development projects',
    });

    expect(long.relevance_score).toBeGreaterThan(short.relevance_score);
  });
});

// ── Storage-adapter parity tests ──────────────────────────────────────────────

describe('SqliteStorageAdapter memory parity', () => {
  let tempDir = '';
  const userId = 'test-user-storage';

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'storage-mem-test-'));
    process.env['DATABASE_PATH'] = join(tempDir, 'test.db');
    closeDb();
    resetEnvCache();
    resetStorageAdapter();
    runMigrations();

    const db = getDb();
    db.prepare('INSERT INTO users (id, email, tier, credits_balance) VALUES (?, ?, ?, ?)').run(
      userId,
      'storagetest@example.test',
      'pro',
      100
    );
  });

  afterEach(() => {
    closeDb();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('saveMemory stores embedding as valid JSON', async () => {
    const storage = getStorage();
    const embedding = [0.1, 0.2, 0.3];
    await storage.saveMemory({
      userId,
      category: 'test',
      key: 'json-vec',
      content: 'Check JSON serialization',
      embedding,
      embeddingModel: 'test-model',
    });

    const db = getDb();
    const row = db.prepare('SELECT embedding, embedding_model FROM user_memories WHERE key = ?').get('json-vec') as {
      embedding: string | null;
      embedding_model: string | null;
    };
    expect(row.embedding_model).toBe('test-model');
    // Must be valid JSON that round-trips to the original array
    expect(JSON.parse(row.embedding!)).toEqual([0.1, 0.2, 0.3]);
  });

  test('recallMemory semantic path works with stored embeddings', async () => {
    const storage = getStorage();
    await storage.saveMemory({
      userId,
      category: 'test',
      key: 'close-match',
      content: 'Semantically close',
      embedding: [1, 0, 0],
      embeddingModel: 'test',
    });
    await storage.saveMemory({
      userId,
      category: 'test',
      key: 'far-match',
      content: 'Semantically far',
      embedding: [0, 0, 1],
      embeddingModel: 'test',
    });

    const results = await storage.recallMemory({
      userId,
      words: [],
      limit: 10,
      queryEmbedding: [1, 0, 0],
    });

    expect(results.length).toBe(1);
    expect(results[0]!['key']).toBe('close-match');
  });

  test('recallMemory keyword path uses OR-join (matches memory.ts)', async () => {
    const storage = getStorage();
    await storage.saveMemory({ userId, category: 'test', key: 'a', content: 'alpha content here' });
    await storage.saveMemory({ userId, category: 'test', key: 'b', content: 'bravo content here' });
    await storage.saveMemory({ userId, category: 'test', key: 'c', content: 'charlie unrelated' });

    // With OR logic: searching ['alpha', 'bravo'] should find both a and b
    // With AND logic (the old bug): nothing would match since no row has both
    const results = await storage.recallMemory({
      userId,
      words: ['alpha', 'bravo'],
      limit: 10,
    });

    expect(results.length).toBe(2);
    const keys = results.map((r) => r['key']);
    expect(keys).toContain('a');
    expect(keys).toContain('b');
  });

  test('recallMemory keyword path is case-insensitive', async () => {
    const storage = getStorage();
    await storage.saveMemory({ userId, category: 'test', key: 'mixed', content: 'TypeScript is Great' });

    const results = await storage.recallMemory({
      userId,
      words: ['typescript'],
      limit: 10,
    });

    expect(results.length).toBe(1);
    expect(results[0]!['key']).toBe('mixed');
  });

  test('recallMemory returns [] for empty words and no embedding', async () => {
    const storage = getStorage();
    await storage.saveMemory({ userId, category: 'test', key: 'x', content: 'something' });

    const results = await storage.recallMemory({ userId, words: [], limit: 10 });
    expect(results).toEqual([]);
  });
});
