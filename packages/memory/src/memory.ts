import { getDb, logger, cosineSimilarity, MIN_MEMORY_SIMILARITY } from '@orchestrator/shared';

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
  /** Pre-computed embedding vector for semantic search. */
  embedding?: number[];
  /** Model identifier that produced the embedding. */
  embeddingModel?: string;
}

/** Parse a JSON-stringified embedding from a DB column value. */
function parseEmbedding(raw: unknown): number[] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is number => typeof v === 'number') : [];
  } catch {
    return [];
  }
}

export function saveMemory(userId: string, input: SaveMemoryInput): Memory {
  const db = getDb();
  const category = input.category ?? 'general';
  const relevanceScore = computeRelevanceScore(input.content);
  const embeddingJson = input.embedding && input.embedding.length > 0 ? JSON.stringify(input.embedding) : null;
  const embeddingModel = input.embeddingModel ?? null;

  const existing = db
    .prepare('SELECT id FROM user_memories WHERE user_id = ? AND key = ?')
    .get(userId, input.key) as { id: string } | undefined;

  if (existing) {
    db.prepare(
      "UPDATE user_memories SET content = ?, category = ?, relevance_score = ?, embedding = ?, embedding_model = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?"
    ).run(input.content, category, relevanceScore, embeddingJson, embeddingModel, existing.id, userId);

    const updated = db.prepare('SELECT * FROM user_memories WHERE id = ?').get(existing.id) as Memory;
    logger.debug({ userId, key: input.key }, 'Memory updated');
    return updated;
  }

  const id = crypto.randomUUID();
  db.prepare(
    'INSERT INTO user_memories (id, user_id, category, key, content, relevance_score, embedding, embedding_model) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, userId, category, input.key, input.content, relevanceScore, embeddingJson, embeddingModel);

  const created = db.prepare('SELECT * FROM user_memories WHERE id = ?').get(id) as Memory;
  logger.debug({ userId, key: input.key }, 'Memory saved');
  return created;
}

/** Compute a basic relevance score based on content richness. */
function computeRelevanceScore(content: string): number {
  let score = 0;
  // Longer content with more substance scores higher
  const words = content.split(/\s+/).filter((w) => w.length > 0);
  score += Math.min(words.length / 10, 3); // up to 3 pts for word count
  // Unique keyword density bonus
  const uniqueWords = new Set(words.map((w) => w.toLowerCase().replace(/[^a-z0-9]/g, '')).filter((w) => w.length > 2));
  score += Math.min(uniqueWords.size / 8, 2); // up to 2 pts for vocabulary
  return Math.round(score * 10) / 10; // 0-5 range, 1 decimal
}

// Common English stop-words we skip when building keyword filters
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'do', 'does', 'did', 'have', 'has', 'had', 'what', 'which', 'who',
  'how', 'when', 'where', 'why', 'i', 'me', 'my', 'you', 'your', 'we',
  'our', 'it', 'its', 'this', 'that', 'these', 'those', 'not', 'no',
  'can', 'will', 'would', 'could', 'should', 'may', 'might', 'about',
  'tell', 'know', 'remember', 'recall',
]);

/**
 * Recall memories for a user by keyword or semantic similarity.
 *
 * When `queryEmbedding` is supplied, cosine-similarity search is used and
 * matches below `MIN_MEMORY_SIMILARITY` are filtered out.  When it is
 * omitted the function falls back to OR-based keyword search on content.
 *
 * Returns `[]` when no meaningful keywords exist and no embedding is provided.
 */
export function recallMemory(userId: string, query: string, limit = 10, queryEmbedding?: number[]): Memory[] {
  const db = getDb();
  // Filter stop-words and keep meaningful keywords for OR-based search
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9]/g, ''))
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
    .slice(0, 6);

  // No meaningful keywords and no embedding → nothing useful to search.
  if (words.length === 0 && (!queryEmbedding || queryEmbedding.length === 0)) {
    return [];
  }

  // ── Semantic path ─────────────────────────────────────────────────────────
  if (queryEmbedding && queryEmbedding.length > 0) {
    const rows = db
      .prepare('SELECT * FROM user_memories WHERE user_id = ?')
      .all(userId) as Array<Record<string, unknown>>;

    const scored = rows
      .map((row) => {
        const embedding = parseEmbedding(row['embedding']);
        const score = embedding.length > 0 ? cosineSimilarity(queryEmbedding, embedding) : -1;
        return { row: row as unknown as Memory, score };
      })
      .filter(({ score }) => Number.isFinite(score) && score >= MIN_MEMORY_SIMILARITY)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    const memories = scored.map(({ row }) => row);

    if (memories.length > 0) {
      const ids = memories.map((m) => m.id);
      const placeholders = ids.map(() => '?').join(',');
      db.prepare(
        `UPDATE user_memories SET access_count = access_count + 1 WHERE id IN (${placeholders})`
      ).run(...ids);
    }

    return memories;
  }

  // ── Keyword path ──────────────────────────────────────────────────────────
  const conditions = words.map(() => 'LOWER(content) LIKE ?').join(' OR ');
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

export function listMemories(userId: string, category?: string, limit = 100, offset = 0): Memory[] {
  const db = getDb();

  if (category) {
    return db
      .prepare('SELECT * FROM user_memories WHERE user_id = ? AND category = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?')
      .all(userId, category, limit, offset) as Memory[];
  }

  return db
    .prepare('SELECT * FROM user_memories WHERE user_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?')
    .all(userId, limit, offset) as Memory[];
}
