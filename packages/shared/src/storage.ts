import { getDb } from './db.js';
import { getEnv } from './env.js';
import { logger } from './logger.js';
import { cosineSimilarity, MIN_MEMORY_SIMILARITY } from './vector.js';

export type StorageBackend = 'sqlite' | 'convex';

export interface CreditTransactionRow {
  id: string;
  user_id: string;
  amount: number;
  balance_after: number;
  description: string;
  reference_type: string | null;
  reference_id: string | null;
  metadata: string | null;
  created_at: string;
}

export interface StorageAdapter {
  readonly backend: StorageBackend;
  adjustBalance(input: {
    userId: string;
    delta: number;
    description: string;
    referenceType?: string;
    referenceId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<number>;
  getBalance(userId: string): Promise<number>;
  getTransactions(userId: string, limit: number, offset: number): Promise<CreditTransactionRow[]>;
  getCurrentPeriodUsage(userId: string, fromIso: string): Promise<{ credits_used: number; request_count: number }>;
  getUsageSummary(input: { userId: string; startDate: string; endDate: string }): Promise<{
    total_cost: number;
    total_requests: number;
    by_reference_type: Array<{ reference_type: string | null; count: number; cost: number }>;
    by_model: Array<{ model: string; requests: number; cost: number; tokens: number }>;
  }>;
  getSessionForChat(
    userId: string,
    chatId: string
  ): Promise<{
    id: string;
    open_terminal_url: string | null;
    open_terminal_api_key: string | null;
    chat_id: string | null;
    status: string;
    environment_status: string;
    workspace_path: string | null;
  } | null>;
  saveMemory(input: {
    userId: string;
    category: string;
    key: string;
    content: string;
    embedding?: number[];
    embeddingModel?: string;
  }): Promise<Record<string, unknown>>;
  recallMemory(input: {
    userId: string;
    words: string[];
    limit: number;
    queryEmbedding?: number[];
  }): Promise<Array<Record<string, unknown>>>;
  bumpMemoryAccess(ids: string[]): Promise<void>;
  deleteMemory(userId: string, id: string): Promise<boolean>;
  listMemories(userId: string, category?: string): Promise<Array<Record<string, unknown>>>;
  recordAgentHealth(input: { agentType: string; model: string; success: boolean; latencyMs?: number }): Promise<void>;
  insertAuditLog(input: { id: string; userId: string; action: string; details: string | null }): Promise<void>;
  setMaintenanceMode(_enabled: boolean): Promise<void>;
}

class SqliteStorageAdapter implements StorageAdapter {
  readonly backend: StorageBackend = 'sqlite';

  async adjustBalance(input: {
    userId: string;
    delta: number;
    description: string;
    referenceType?: string;
    referenceId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<number> {
    const db = getDb();
    return db.transaction(() => {
      const user = db.prepare('SELECT credits_balance FROM users WHERE id = ?').get(input.userId) as
        | { credits_balance: number }
        | undefined;

      if (!user) {
        throw new Error('user_not_found');
      }

      if (input.delta < 0 && user.credits_balance < -input.delta) {
        throw new Error(`insufficient_credits:${user.credits_balance}:${-input.delta}`);
      }

      const newBalance = Math.round((user.credits_balance + input.delta) * 1_000_000) / 1_000_000;
      db.prepare('UPDATE users SET credits_balance = ? WHERE id = ?').run(newBalance, input.userId);
      db.prepare(
        `INSERT INTO credit_transactions (id, user_id, amount, balance_after, description, reference_type, reference_id, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        crypto.randomUUID(),
        input.userId,
        input.delta,
        newBalance,
        input.description,
        input.referenceType ?? null,
        input.referenceId ?? null,
        input.metadata ? JSON.stringify(input.metadata) : null
      );
      return newBalance;
    })();
  }

  async getBalance(userId: string): Promise<number> {
    const row = getDb().prepare('SELECT credits_balance FROM users WHERE id = ?').get(userId) as
      | { credits_balance: number }
      | undefined;
    return row?.credits_balance ?? 0;
  }

  async getTransactions(userId: string, limit: number, offset: number): Promise<CreditTransactionRow[]> {
    return getDb()
      .prepare('SELECT * FROM credit_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?')
      .all(userId, limit, offset) as CreditTransactionRow[];
  }

  async getCurrentPeriodUsage(
    userId: string,
    fromIso: string
  ): Promise<{ credits_used: number; request_count: number }> {
    return getDb()
      .prepare(
        `SELECT
          COALESCE(SUM(ABS(amount)), 0) as credits_used,
          COUNT(*) as request_count
        FROM credit_transactions
        WHERE user_id = ? AND amount < 0 AND created_at >= ?`
      )
      .get(userId, fromIso) as { credits_used: number; request_count: number };
  }

  async getUsageSummary(input: { userId: string; startDate: string; endDate: string }): Promise<{
    total_cost: number;
    total_requests: number;
    by_reference_type: Array<{ reference_type: string | null; count: number; cost: number }>;
    by_model: Array<{ model: string; requests: number; cost: number; tokens: number }>;
  }> {
    const db = getDb();
    const totals = db
      .prepare(
        `SELECT
          COALESCE(SUM(ABS(amount)), 0) as total_cost,
          COUNT(*) as total_requests
        FROM credit_transactions
        WHERE user_id = ? AND amount < 0 AND created_at >= ? AND created_at <= ?`
      )
      .get(input.userId, input.startDate, input.endDate) as { total_cost: number; total_requests: number };

    const byType = db
      .prepare(
        `SELECT reference_type, COUNT(*) as count, COALESCE(SUM(ABS(amount)), 0) as cost
        FROM credit_transactions
        WHERE user_id = ? AND amount < 0 AND created_at >= ? AND created_at <= ?
        GROUP BY reference_type`
      )
      .all(input.userId, input.startDate, input.endDate) as Array<{
      reference_type: string | null;
      count: number;
      cost: number;
    }>;

    const byModel = db
      .prepare(
        `SELECT
          json_extract(metadata, '$.model') as model,
          COUNT(*) as requests,
          COALESCE(SUM(ABS(amount)), 0) as cost,
          COALESCE(SUM(json_extract(metadata, '$.total_tokens')), 0) as tokens
        FROM credit_transactions
        WHERE user_id = ? AND amount < 0 AND created_at >= ? AND created_at <= ?
          AND metadata IS NOT NULL
          AND json_extract(metadata, '$.model') IS NOT NULL
        GROUP BY json_extract(metadata, '$.model')`
      )
      .all(input.userId, input.startDate, input.endDate) as Array<{
      model: string;
      requests: number;
      cost: number;
      tokens: number;
    }>;

    return {
      ...totals,
      by_reference_type: byType,
      by_model: byModel,
    };
  }

  async getSessionForChat(
    userId: string,
    chatId: string
  ): Promise<{
    id: string;
    open_terminal_url: string | null;
    open_terminal_api_key: string | null;
    chat_id: string | null;
    status: string;
    environment_status: string;
    workspace_path: string | null;
  } | null> {
    const row = getDb()
      .prepare(
        `SELECT s.id, s.open_terminal_url, s.open_terminal_api_key, s.chat_id, s.status, s.environment_status, w.workspace_path
         FROM sandbox_sessions s
         LEFT JOIN sandbox_workspaces w ON w.chat_id = s.chat_id AND w.user_id = s.user_id
         WHERE s.chat_id = ? AND s.user_id = ? AND s.status IN ('ready', 'executing')
         ORDER BY s.created_at DESC LIMIT 1`
      )
      .get(chatId, userId) as
      | {
          id: string;
          open_terminal_url: string | null;
          open_terminal_api_key: string | null;
          chat_id: string | null;
          status: string;
          environment_status: string;
          workspace_path: string | null;
        }
      | undefined;

    return row ?? null;
  }

  async saveMemory(input: {
    userId: string;
    category: string;
    key: string;
    content: string;
    embedding?: number[];
    embeddingModel?: string;
  }): Promise<Record<string, unknown>> {
    const db = getDb();
    const embeddingJson = input.embedding && input.embedding.length > 0 ? JSON.stringify(input.embedding) : null;
    const embeddingModel = input.embeddingModel ?? null;
    const existing = db
      .prepare('SELECT id FROM user_memories WHERE user_id = ? AND key = ?')
      .get(input.userId, input.key) as { id: string } | undefined;

    if (existing) {
      db.prepare(
        "UPDATE user_memories SET content = ?, category = ?, embedding = ?, embedding_model = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?"
      ).run(input.content, input.category, embeddingJson, embeddingModel, existing.id, input.userId);
      return db.prepare('SELECT * FROM user_memories WHERE id = ?').get(existing.id) as Record<string, unknown>;
    }

    const id = crypto.randomUUID();
    db.prepare(
      'INSERT INTO user_memories (id, user_id, category, key, content, embedding, embedding_model) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(id, input.userId, input.category, input.key, input.content, embeddingJson, embeddingModel);
    return db.prepare('SELECT * FROM user_memories WHERE id = ?').get(id) as Record<string, unknown>;
  }

  async recallMemory(input: {
    userId: string;
    words: string[];
    limit: number;
    queryEmbedding?: number[];
  }): Promise<Array<Record<string, unknown>>> {
    // Semantic path
    if (input.queryEmbedding && input.queryEmbedding.length > 0) {
      const rows = getDb().prepare('SELECT * FROM user_memories WHERE user_id = ?').all(input.userId) as Array<
        Record<string, unknown>
      >;

      return rows
        .map((row) => {
          let embedding: number[] = [];
          if (typeof row['embedding'] === 'string' && row['embedding']) {
            try {
              const parsed: unknown = JSON.parse(row['embedding']);
              embedding = Array.isArray(parsed) ? parsed.filter((v): v is number => typeof v === 'number') : [];
            } catch {
              /* ignore malformed */
            }
          }
          const score = embedding.length > 0 ? cosineSimilarity(input.queryEmbedding!, embedding) : -1;
          return { row, score };
        })
        .filter(({ score }) => Number.isFinite(score) && score >= MIN_MEMORY_SIMILARITY)
        .sort((a, b) => b.score - a.score)
        .slice(0, input.limit)
        .map(({ row }) => row);
    }

    // Keyword path — OR-joined, case-insensitive (matches memory.ts)
    if (input.words.length === 0) return [];
    const conditions = input.words.map(() => 'LOWER(content) LIKE ?').join(' OR ');
    const params = input.words.map((word) => `%${word.toLowerCase()}%`);
    return getDb()
      .prepare(
        `SELECT * FROM user_memories WHERE user_id = ? AND (${conditions})
         ORDER BY relevance_score DESC, access_count DESC
         LIMIT ?`
      )
      .all(input.userId, ...params, input.limit) as Array<Record<string, unknown>>;
  }

  async bumpMemoryAccess(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    getDb()
      .prepare(`UPDATE user_memories SET access_count = access_count + 1 WHERE id IN (${placeholders})`)
      .run(...ids);
  }

  async deleteMemory(userId: string, id: string): Promise<boolean> {
    const result = getDb().prepare('DELETE FROM user_memories WHERE id = ? AND user_id = ?').run(id, userId);
    return result.changes > 0;
  }

  async listMemories(userId: string, category?: string): Promise<Array<Record<string, unknown>>> {
    if (category) {
      return getDb()
        .prepare('SELECT * FROM user_memories WHERE user_id = ? AND category = ? ORDER BY updated_at DESC')
        .all(userId, category) as Array<Record<string, unknown>>;
    }

    return getDb()
      .prepare('SELECT * FROM user_memories WHERE user_id = ? ORDER BY updated_at DESC')
      .all(userId) as Array<Record<string, unknown>>;
  }

  async recordAgentHealth(input: {
    agentType: string;
    model: string;
    success: boolean;
    latencyMs?: number;
  }): Promise<void> {
    const db = getDb();
    if (input.success && input.latencyMs !== undefined) {
      db.prepare(
        `
        INSERT INTO agent_health (id, agent_type, model, status, last_success_at, success_count_1h, total_latency_ms_1h)
        VALUES (?, ?, ?, 'healthy', datetime('now'), 1, ?)
        ON CONFLICT(agent_type, model) DO UPDATE SET
          status = 'healthy',
          last_success_at = datetime('now'),
          success_count_1h = success_count_1h + 1,
          total_latency_ms_1h = total_latency_ms_1h + excluded.total_latency_ms_1h,
          updated_at = datetime('now')
      `
      ).run(crypto.randomUUID(), input.agentType, input.model, input.latencyMs);
      return;
    }

    if (!input.success) {
      db.prepare(
        `
        INSERT INTO agent_health (id, agent_type, model, status, last_failure_at, failure_count_1h)
        VALUES (?, ?, ?, 'degraded', datetime('now'), 1)
        ON CONFLICT(agent_type, model) DO UPDATE SET
          last_failure_at = datetime('now'),
          failure_count_1h = failure_count_1h + 1,
          status = CASE
            WHEN failure_count_1h + 1 >= 5 THEN 'unavailable'
            WHEN failure_count_1h + 1 >= 2 THEN 'degraded'
            ELSE 'healthy'
          END,
          updated_at = datetime('now')
      `
      ).run(crypto.randomUUID(), input.agentType, input.model);
    }
  }

  async insertAuditLog(input: { id: string; userId: string; action: string; details: string | null }): Promise<void> {
    getDb()
      .prepare('INSERT INTO audit_log (id, user_id, action, details) VALUES (?, ?, ?, ?)')
      .run(input.id, input.userId, input.action, input.details);
  }

  async setMaintenanceMode(_enabled: boolean): Promise<void> {
    // Only meaningful for Convex / externalized storage.
  }
}

class ConvexStorageAdapter implements StorageAdapter {
  readonly backend: StorageBackend = 'convex';

  private readonly baseUrl: string;
  private readonly adminKey: string;

  constructor() {
    const env = getEnv();
    if (!env.CONVEX_URL || !env.CONVEX_ADMIN_KEY) {
      throw new Error('CONVEX_URL and CONVEX_ADMIN_KEY are required when STORAGE_BACKEND=convex');
    }
    this.baseUrl = env.CONVEX_URL.replace(/\/$/, '');
    this.adminKey = env.CONVEX_ADMIN_KEY;
  }

  private async invoke<T>(path: string, payload: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.adminKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`convex_request_failed:${response.status}:${text}`);
    }

    return (await response.json()) as T;
  }

  async adjustBalance(input: {
    userId: string;
    delta: number;
    description: string;
    referenceType?: string;
    referenceId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<number> {
    const result = await this.invoke<{ newBalance: number }>('/storage/adjustBalance', input);
    return result.newBalance;
  }

  async getBalance(userId: string): Promise<number> {
    const result = await this.invoke<{ balance: number }>('/storage/getBalance', { userId });
    return result.balance;
  }

  async getTransactions(userId: string, limit: number, offset: number): Promise<CreditTransactionRow[]> {
    return this.invoke<CreditTransactionRow[]>('/storage/getTransactions', { userId, limit, offset });
  }

  async getCurrentPeriodUsage(
    userId: string,
    fromIso: string
  ): Promise<{ credits_used: number; request_count: number }> {
    return this.invoke('/storage/getCurrentPeriodUsage', { userId, fromIso });
  }

  async getUsageSummary(input: { userId: string; startDate: string; endDate: string }): Promise<{
    total_cost: number;
    total_requests: number;
    by_reference_type: Array<{ reference_type: string | null; count: number; cost: number }>;
    by_model: Array<{ model: string; requests: number; cost: number; tokens: number }>;
  }> {
    return this.invoke('/storage/getUsageSummary', input);
  }

  async getSessionForChat(
    userId: string,
    chatId: string
  ): Promise<{
    id: string;
    open_terminal_url: string | null;
    open_terminal_api_key: string | null;
    chat_id: string | null;
    status: string;
    environment_status: string;
    workspace_path: string | null;
  } | null> {
    return this.invoke('/storage/getSessionForChat', { userId, chatId });
  }

  async saveMemory(input: {
    userId: string;
    category: string;
    key: string;
    content: string;
    embedding?: number[];
    embeddingModel?: string;
  }): Promise<Record<string, unknown>> {
    return this.invoke('/storage/saveMemory', input);
  }

  async recallMemory(input: {
    userId: string;
    words: string[];
    limit: number;
    queryEmbedding?: number[];
  }): Promise<Array<Record<string, unknown>>> {
    return this.invoke('/storage/recallMemory', input);
  }

  async bumpMemoryAccess(ids: string[]): Promise<void> {
    await this.invoke('/storage/bumpMemoryAccess', { ids });
  }

  async deleteMemory(userId: string, id: string): Promise<boolean> {
    const result = await this.invoke<{ deleted: boolean }>('/storage/deleteMemory', { userId, id });
    return result.deleted;
  }

  async listMemories(userId: string, category?: string): Promise<Array<Record<string, unknown>>> {
    return this.invoke('/storage/listMemories', { userId, category });
  }

  async recordAgentHealth(input: {
    agentType: string;
    model: string;
    success: boolean;
    latencyMs?: number;
  }): Promise<void> {
    await this.invoke('/storage/recordAgentHealth', input);
  }

  async insertAuditLog(input: { id: string; userId: string; action: string; details: string | null }): Promise<void> {
    await this.invoke('/storage/insertAuditLog', input);
  }

  async setMaintenanceMode(enabled: boolean): Promise<void> {
    await this.invoke('/storage/setMaintenanceMode', { enabled });
  }
}

let adapter: StorageAdapter | null = null;

export function getStorage(): StorageAdapter {
  if (adapter) return adapter;

  const backend = getEnv().STORAGE_BACKEND;
  if (backend === 'convex') {
    adapter = new ConvexStorageAdapter();
    logger.info('Using Convex storage adapter');
    return adapter;
  }

  adapter = new SqliteStorageAdapter();
  logger.info('Using SQLite storage adapter');
  return adapter;
}

export function resetStorageAdapter(): void {
  adapter = null;
}
