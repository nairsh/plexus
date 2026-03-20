import { getDb, logger } from '@orchestrator/shared';

export interface Memory {
  id: string;
  user_id: string;
  category: string;
  key: string;
  content: string;
  relevance_score: number;
  access_count: number;
  created_at: string;
  updated_at: string;
}

export interface SaveMemoryInput {
  category?: string;
  key: string;
  content: string;
}

export function saveMemory(userId: string, input: SaveMemoryInput): Memory {
  const db = getDb();
  const category = input.category ?? 'general';

  const existing = db
    .prepare('SELECT id FROM user_memories WHERE user_id = ? AND key = ?')
    .get(userId, input.key) as { id: string } | undefined;

  if (existing) {
    db.prepare(
      "UPDATE user_memories SET content = ?, category = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?"
    ).run(input.content, category, existing.id, userId);

    const updated = db.prepare('SELECT * FROM user_memories WHERE id = ?').get(existing.id) as Memory;
    logger.debug({ userId, key: input.key }, 'Memory updated');
    return updated;
  }

  const id = crypto.randomUUID();
  db.prepare(
    'INSERT INTO user_memories (id, user_id, category, key, content) VALUES (?, ?, ?, ?, ?)'
  ).run(id, userId, category, input.key, input.content);

  const created = db.prepare('SELECT * FROM user_memories WHERE id = ?').get(id) as Memory;
  logger.debug({ userId, key: input.key }, 'Memory saved');
  return created;
}

export function recallMemory(userId: string, query: string, limit = 10): Memory[] {
  const db = getDb();
  const words = query.split(/\s+/).filter(Boolean).slice(0, 3);

  if (words.length === 0) {
    return [];
  }

  const conditions = words.map(() => 'content LIKE ?').join(' AND ');
  const params = words.map((w) => `%${w}%`);

  const memories = db
    .prepare(
      `SELECT * FROM user_memories WHERE user_id = ? AND (${conditions})
       ORDER BY relevance_score DESC, access_count DESC
       LIMIT ?`
    )
    .all(userId, ...params, limit) as Memory[];

  if (memories.length > 0) {
    const ids = memories.map((m) => m.id);
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(
      `UPDATE user_memories SET access_count = access_count + 1 WHERE id IN (${placeholders})`
    ).run(...ids);
  }

  return memories;
}

export function deleteMemory(userId: string, id: string): boolean {
  const db = getDb();
  const result = db
    .prepare('DELETE FROM user_memories WHERE id = ? AND user_id = ?')
    .run(id, userId);
  return result.changes > 0;
}

export function listMemories(userId: string, category?: string): Memory[] {
  const db = getDb();

  if (category) {
    return db
      .prepare('SELECT * FROM user_memories WHERE user_id = ? AND category = ? ORDER BY updated_at DESC')
      .all(userId, category) as Memory[];
  }

  return db
    .prepare('SELECT * FROM user_memories WHERE user_id = ? ORDER BY updated_at DESC')
    .all(userId) as Memory[];
}
