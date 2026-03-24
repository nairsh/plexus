import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { TopUpSchema, UsageQuerySchema, InvalidRequestError } from '@orchestrator/shared';
import { creditBalance, getBalance, getTransactions, getUsageSummary, getCurrentPeriodUsage } from '@orchestrator/billing';

export async function billingRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /v1/billing/balance
   */
  fastify.get('/v1/billing/balance', async (request: FastifyRequest) => {
    const user = request.user!;
    const balance = await getBalance(user.id);
    const periodUsage = getCurrentPeriodUsage(user.id);

    return {
      credits_balance: balance,
      tier: user.tier,
      usage_this_period: periodUsage,
    };
  });

  /**
   * GET /v1/billing/usage
   */
  fastify.get(
    '/v1/billing/usage',
    async (request: FastifyRequest<{ Querystring: { start?: string; end?: string } }>) => {
      const user = request.user!;
      const query = UsageQuerySchema.safeParse(request.query);
      if (!query.success) {
        throw new InvalidRequestError('Invalid query parameters');
      }

      const usage = getUsageSummary(user.id, query.data.start, query.data.end);
      return usage;
    }
  );

  /**
   * POST /v1/billing/top-up
   */
  fastify.post('/v1/billing/top-up', async (request: FastifyRequest, reply: FastifyReply) => {
    const parseResult = TopUpSchema.safeParse(request.body);
    if (!parseResult.success) {
      throw new InvalidRequestError('Invalid top-up amount. Provide { amount: number }');
    }

    const user = request.user!;
    const newBalance = await creditBalance(user.id, parseResult.data.amount, 'Manual top-up', 'topup');

    reply.status(200);
    return {
      credits_balance: newBalance,
      amount_added: parseResult.data.amount,
    };
  });

  /**
   * GET /v1/billing/transactions
   */
  fastify.get(
    '/v1/billing/transactions',
    async (request: FastifyRequest<{ Querystring: { limit?: string; offset?: string } }>) => {
      const user = request.user!;
      const rawLimit = parseInt(request.query.limit || '50', 10);
      const rawOffset = parseInt(request.query.offset || '0', 10);
      const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 50, 1), 100);
      const offset = Math.max(Number.isFinite(rawOffset) ? rawOffset : 0, 0);

      const transactions = await getTransactions(user.id, limit, offset);
      return { transactions };
    }
  );
}
