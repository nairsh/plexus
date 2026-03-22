import { getEnv, getStorage, logger } from '@orchestrator/shared';

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
  const storage = getStorage();
  return storage.adjustBalance({
    userId,
    delta,
    description,
    referenceType,
    referenceId,
    metadata,
  }) as unknown as number;
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
  if (getEnv().BILLING_MODE !== 'enforced') {
    const balance = getBalance(userId);
    logger.debug({ userId, amount, description, balance }, 'Billing mode is non-enforced, skipping debit');
    return balance;
  }

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
  return getStorage().getBalance(userId) as unknown as number;
}

/**
 * Get recent transactions for a user.
 */
export function getTransactions(
  userId: string,
  limit = 50,
  offset = 0
): CreditTransaction[] {
  return getStorage().getTransactions(userId, limit, offset) as unknown as CreditTransaction[];
}
