import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { closeDb, getDb, runMigrations, resetEnvCache } from '@orchestrator/shared';
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
      userId, 'memtest@example.test', 'pro', 100
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

  test('recallMemory finds memories by keywords', () => {
    saveMemory(userId, { key: 'lang', content: 'I use Python for data science tasks' });
    saveMemory(userId, { key: 'editor', content: 'VS Code is my preferred editor' });

    const results = recallMemory(userId, 'What Python tools do you use?');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.content).toContain('Python');
  });

  test('recallMemory returns recent memories when no keywords match', () => {
    saveMemory(userId, { key: 'fact1', content: 'Memory alpha one' });
    saveMemory(userId, { key: 'fact2', content: 'Memory beta two' });

    // Query with only stop words should fall back to recent memories
    const results = recallMemory(userId, 'the and or but');
    expect(results.length).toBe(2);
  });

  test('recallMemory increments access_count', () => {
    saveMemory(userId, { key: 'tool', content: 'I use Docker containers extensively' });

    recallMemory(userId, 'Docker setup');
    const memories = listMemories(userId);
    const docker = memories.find((m) => m.key === 'tool');
    expect(docker!.access_count).toBe(1);
  });

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
      content: 'I prefer using TypeScript with strict mode enabled and React with functional components and hooks for all frontend development projects',
    });

    expect(long.relevance_score).toBeGreaterThan(short.relevance_score);
  });
});
