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

async function adjustBalance(
  userId: string,
  delta: number,
  description: string,
  referenceType?: string,
  referenceId?: string,
  metadata?: Record<string, unknown>
): Promise<number> {
  const storage = getStorage();
  return storage.adjustBalance({
    userId,
    delta,
    description,
    referenceType,
    referenceId,
    metadata,
  });
}

/**
 * Debit credits from a user's balance. Atomic SQLite transaction.
 * Returns the new balance, or throws if insufficient credits.
 */
export async function debitCredits(
  userId: string,
  amount: number,
  description: string,
  referenceType?: string,
  referenceId?: string,
  metadata?: Record<string, unknown>
): Promise<number> {
  if (getEnv().BILLING_MODE !== 'enforced') {
    const balance = await getBalance(userId);
    logger.debug({ userId, amount, description, balance }, 'Billing mode is non-enforced, skipping debit');
    return balance;
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    logger.warn({ userId, amount, description }, 'Invalid debit amount, skipping');
    return getBalance(userId);
  }

  const absAmount = Math.abs(amount);
  const newBalance = await adjustBalance(userId, -absAmount, description, referenceType, referenceId, metadata);
  logger.info({ userId, amount: absAmount, description, newBalance }, 'Credits debited');
  return newBalance;
}

/**
 * Add credits to a user's balance. Atomic SQLite transaction.
 */
export async function creditBalance(
  userId: string,
  amount: number,
  description: string,
  referenceType?: string,
  referenceId?: string,
  metadata?: Record<string, unknown>
): Promise<number> {
  if (!Number.isFinite(amount) || amount <= 0) {
    logger.warn({ userId, amount, description }, 'Invalid credit amount, skipping');
    return getBalance(userId);
  }

  const absAmount = Math.abs(amount);
  const newBalance = await adjustBalance(userId, absAmount, description, referenceType, referenceId, metadata);
  logger.info({ userId, amount: absAmount, description, newBalance }, 'Credits added');
  return newBalance;
}

/**
 * Get user's credit balance.
 */
export async function getBalance(userId: string): Promise<number> {
  return getStorage().getBalance(userId);
}

/**
 * Get recent transactions for a user.
 */
export async function getTransactions(userId: string, limit = 50, offset = 0): Promise<CreditTransaction[]> {
  return getStorage().getTransactions(userId, limit, offset) as Promise<CreditTransaction[]>;
}
