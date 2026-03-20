import { getDb, logger, BillingError } from '@orchestrator/shared';

export interface CreditTransaction {
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

function adjustBalance(
  userId: string,
  delta: number,
  description: string,
  referenceType?: string,
  referenceId?: string,
  metadata?: Record<string, unknown>
): number {
  const db = getDb();

  const result = db.transaction(() => {
    const user = db
      .prepare('SELECT credits_balance FROM users WHERE id = ?')
      .get(userId) as { credits_balance: number } | undefined;

    if (!user) {
      throw new BillingError('User not found', 'user_not_found');
    }

    if (delta < 0 && user.credits_balance < -delta) {
      throw new BillingError(
        `Insufficient credits. Balance: ${user.credits_balance}, Required: ${-delta}`,
        'insufficient_credits'
      );
    }

    const newBalance = Math.round((user.credits_balance + delta) * 1_000_000) / 1_000_000;

    db.prepare('UPDATE users SET credits_balance = ? WHERE id = ?').run(newBalance, userId);

    db.prepare(
      `INSERT INTO credit_transactions (id, user_id, amount, balance_after, description, reference_type, reference_id, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      crypto.randomUUID(),
      userId,
      delta,
      newBalance,
      description,
      referenceType ?? null,
      referenceId ?? null,
      metadata ? JSON.stringify(metadata) : null
    );

    return newBalance;
  })();

  return result;
}

/**
 * Debit credits from a user's balance. Atomic SQLite transaction.
 * Returns the new balance, or throws if insufficient credits.
 */
export function debitCredits(
  userId: string,
  amount: number,
  description: string,
  referenceType?: string,
  referenceId?: string,
  metadata?: Record<string, unknown>
): number {
  const absAmount = Math.abs(amount);
  const newBalance = adjustBalance(userId, -absAmount, description, referenceType, referenceId, metadata);
  logger.info({ userId, amount: absAmount, description, newBalance }, 'Credits debited');
  return newBalance;
}

/**
 * Add credits to a user's balance. Atomic SQLite transaction.
 */
export function creditBalance(
  userId: string,
  amount: number,
  description: string,
  referenceType?: string,
  referenceId?: string,
  metadata?: Record<string, unknown>
): number {
  const absAmount = Math.abs(amount);
  const newBalance = adjustBalance(userId, absAmount, description, referenceType, referenceId, metadata);
  logger.info({ userId, amount: absAmount, description, newBalance }, 'Credits added');
  return newBalance;
}

/**
 * Get user's credit balance.
 */
export function getBalance(userId: string): number {
  const db = getDb();
  const row = db
    .prepare('SELECT credits_balance FROM users WHERE id = ?')
    .get(userId) as { credits_balance: number } | undefined;

  return row?.credits_balance ?? 0;
}

/**
 * Get recent transactions for a user.
 */
export function getTransactions(
  userId: string,
  limit = 50,
  offset = 0
): CreditTransaction[] {
  const db = getDb();
  return db
    .prepare(
      'SELECT * FROM credit_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
    )
    .all(userId, limit, offset) as CreditTransaction[];
}
