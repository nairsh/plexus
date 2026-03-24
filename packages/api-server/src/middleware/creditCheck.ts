import type { FastifyRequest, FastifyReply } from 'fastify';
import { BillingError, getEnv } from '@orchestrator/shared';

/**
 * Pre-flight check that the user has a non-zero credit balance.
 * Actual cost deduction happens after the request completes.
 */
export async function creditCheckMiddleware(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (getEnv().BILLING_MODE !== 'enforced') return;

  const user = request.user;
  if (!user) return;

  // Enterprise tier users bypass credit checks
  if (user.tier === 'enterprise') return;

  if (user.credits_balance <= 0) {
    const err = new BillingError('Insufficient credits. Please top up your balance.', 'insufficient_credits');
    reply.status(err.statusCode).send(err.toJSON());
    return;
  }
}
