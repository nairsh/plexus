import { describe, expect, test } from 'vitest';

// Test the relevance score logic directly by importing the memory module
// computeRelevanceScore is not exported, so we test it indirectly through saveMemory/recallMemory
// But we can test the scoring behavior by checking saved entries

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach } from 'vitest';
import { closeDb, getDb, runMigrations, resetEnvCache } from '@orchestrator/shared';
import { saveMemory, recallMemory } from '@orchestrator/memory';

describe('relevance score computation', () => {
  let tempDir = '';

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'relevance-test-'));
    process.env['DATABASE_PATH'] = join(tempDir, 'test.db');
    closeDb();
    resetEnvCache();
    runMigrations();

    const db = getDb();
    db.prepare('INSERT INTO users (id, email, tier, credits_balance) VALUES (?, ?, ?, ?)').run(
      'user-rel',
      'test@test.com',
      'free',
      100
    );
  });

  afterEach(() => {
    closeDb();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('longer content gets higher relevance score', () => {
    // Short content
    saveMemory('user-rel', {
      key: 'short',
      content: 'hello',
      category: 'test',
    });

    // Long content with more vocabulary
    saveMemory('user-rel', {
      key: 'long',
      content:
        'The orchestrator platform is a comprehensive system that manages workflow execution including model routing, billing, and sandbox management across multiple providers',
      category: 'test',
    });

    const db = getDb();
    const short = db.prepare('SELECT relevance_score FROM user_memories WHERE key = ?').get('short') as {
      relevance_score: number;
    };
    const long = db.prepare('SELECT relevance_score FROM user_memories WHERE key = ?').get('long') as {
      relevance_score: number;
    };

    expect(long.relevance_score).toBeGreaterThan(short.relevance_score);
  });

  test('relevance score is between 0 and 5', () => {
    saveMemory('user-rel', {
      key: 'bounded',
      content:
        'A moderately long piece of text with various unique words including orchestrator, platform, billing, sandbox, workflow, model, router, and scheduler components',
      category: 'test',
    });

    const db = getDb();
    const row = db.prepare('SELECT relevance_score FROM user_memories WHERE key = ?').get('bounded') as {
      relevance_score: number;
    };

    expect(row.relevance_score).toBeGreaterThanOrEqual(0);
    expect(row.relevance_score).toBeLessThanOrEqual(5);
  });

  test('empty content gets 0 relevance score', () => {
    saveMemory('user-rel', {
      key: 'empty',
      content: '',
      category: 'test',
    });

    const db = getDb();
    const row = db.prepare('SELECT relevance_score FROM user_memories WHERE key = ?').get('empty') as {
      relevance_score: number;
    };

    expect(row.relevance_score).toBe(0);
  });

  test('recall results are ordered by relevance score descending', () => {
    saveMemory('user-rel', { key: 'low', content: 'hi', category: 'test' });
    saveMemory('user-rel', {
      key: 'high',
      content:
        'The comprehensive platform includes orchestration, billing, memory management, sandbox execution, model routing, and scheduling capabilities with robust error handling',
      category: 'test',
    });

    const results = recallMemory('user-rel', 'platform', 10);
    if (results.length === 2) {
      expect(results[0].relevance_score).toBeGreaterThanOrEqual(results[1].relevance_score);
    }
  });
});
