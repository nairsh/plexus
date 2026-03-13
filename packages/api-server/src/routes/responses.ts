import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { AgentRequestSchema, InvalidRequestError, logger } from '@orchestrator/shared';
import type { AgentRequest } from '@orchestrator/shared';
import { routeRequest, routeStreamingRequest } from '@orchestrator/model-router';
import { debitCredits } from '@orchestrator/billing';

export async function responsesRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * POST /v1/responses — The Agent API workhorse endpoint.
   */
  fastify.post(
    '/v1/responses',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseResult = AgentRequestSchema.safeParse(request.body);
      if (!parseResult.success) {
        const firstError = parseResult.error.errors[0];
        throw new InvalidRequestError(
          `Validation error: ${firstError?.message ?? 'Invalid request'}`,
          firstError?.path?.join('.') ?? undefined
        );
      }

      const agentRequest = parseResult.data as AgentRequest;
      const userId = request.user!.id;

      // Handle streaming
      if (agentRequest.stream) {
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });

        try {
          const stream = routeStreamingRequest(agentRequest);
          for await (const chunk of stream) {
            reply.raw.write(`event: ${chunk.type}\ndata: ${JSON.stringify(chunk)}\n\n`);
          }
        } catch (err) {
          reply.raw.write(
            `event: error\ndata: ${JSON.stringify({ type: 'error', data: { message: (err as Error).message } })}\n\n`
          );
        }

        reply.raw.end();
        return;
      }

      // Non-streaming
      const response = await routeRequest(agentRequest);

      // Debit credits
      if (response.usage.cost.total_cost > 0) {
        try {
          debitCredits(
            userId,
            response.usage.cost.total_cost,
            `API response: ${response.model}`,
            'response',
            response.id,
            {
              model: response.model,
              input_tokens: response.usage.input_tokens,
              output_tokens: response.usage.output_tokens,
              total_tokens: response.usage.total_tokens,
            }
          );
        } catch (err) {
          // Log but don't fail the request if billing fails
          logger.error(
            { userId, error: (err as Error).message },
            'Failed to debit credits'
          );
        }
      }

      // Log to audit
      try {
        const { getDb } = await import('@orchestrator/shared');
        const db = getDb();
        db.prepare(
          `INSERT INTO audit_log (id, user_id, action, details) VALUES (?, ?, ?, ?)`
        ).run(
          crypto.randomUUID(),
          userId,
          'api_response',
          JSON.stringify({
            model: response.model,
            tokens: response.usage.total_tokens,
            cost: response.usage.cost.total_cost,
          })
        );
      } catch {
        // Audit logging failure is non-critical
      }

      return response;
    }
  );
}
