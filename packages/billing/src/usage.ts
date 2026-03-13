import { getDb } from '@orchestrator/shared';

export interface UsageSummary {
  total_cost: number;
  total_requests: number;
  by_model: Record<string, { requests: number; cost: number; tokens: number }>;
  by_reference_type: Record<string, { count: number; cost: number }>;
}

/**
 * Get aggregated usage for a user over a date range.
 */
export function getUsageSummary(
  userId: string,
  start?: string,
  end?: string
): UsageSummary {
  const db = getDb();

  const startDate = start || '2000-01-01';
  const endDate = end || '2999-12-31';

  // Total cost and count
  const totals = db
    .prepare(
      `SELECT
        COALESCE(SUM(ABS(amount)), 0) as total_cost,
        COUNT(*) as total_requests
       FROM credit_transactions
       WHERE user_id = ? AND amount < 0 AND created_at >= ? AND created_at <= ?`
    )
    .get(userId, startDate, endDate) as { total_cost: number; total_requests: number };

  // By reference type
  const byType = db
    .prepare(
      `SELECT
        reference_type,
        COUNT(*) as count,
        COALESCE(SUM(ABS(amount)), 0) as cost
       FROM credit_transactions
       WHERE user_id = ? AND amount < 0 AND created_at >= ? AND created_at <= ?
       GROUP BY reference_type`
    )
    .all(userId, startDate, endDate) as Array<{
    reference_type: string | null;
    count: number;
    cost: number;
  }>;

  // By model (from metadata JSON)
  const byModel: Record<string, { requests: number; cost: number; tokens: number }> = {};
  const txns = db
    .prepare(
      `SELECT metadata, amount
       FROM credit_transactions
       WHERE user_id = ? AND amount < 0 AND created_at >= ? AND created_at <= ? AND metadata IS NOT NULL`
    )
    .all(userId, startDate, endDate) as Array<{ metadata: string; amount: number }>;

  for (const txn of txns) {
    try {
      const meta = JSON.parse(txn.metadata) as {
        model?: string;
        total_tokens?: number;
      };
      if (meta.model) {
        if (!byModel[meta.model]) {
          byModel[meta.model] = { requests: 0, cost: 0, tokens: 0 };
        }
        byModel[meta.model].requests++;
        byModel[meta.model].cost += Math.abs(txn.amount);
        byModel[meta.model].tokens += meta.total_tokens ?? 0;
      }
    } catch {
      // Skip invalid metadata
    }
  }

  const byRefType: Record<string, { count: number; cost: number }> = {};
  for (const row of byType) {
    const key = row.reference_type || 'unknown';
    byRefType[key] = { count: row.count, cost: row.cost };
  }

  return {
    total_cost: totals.total_cost,
    total_requests: totals.total_requests,
    by_model: byModel,
    by_reference_type: byRefType,
  };
}

/**
 * Get current period usage (current month).
 */
export function getCurrentPeriodUsage(userId: string): {
  credits_used: number;
  request_count: number;
} {
  const db = getDb();
  const now = new Date();
  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');

  const result = db
    .prepare(
      `SELECT
        COALESCE(SUM(ABS(amount)), 0) as credits_used,
        COUNT(*) as request_count
       FROM credit_transactions
       WHERE user_id = ? AND amount < 0 AND created_at >= ?`
    )
    .get(userId, firstOfMonth) as { credits_used: number; request_count: number };

  return result;
}
