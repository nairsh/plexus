import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { AgentRequestSchema, InvalidRequestError, getErrorMessage, logger, getDb } from '@orchestrator/shared';
import type { AgentRequest } from '@orchestrator/shared';
import { routeRequest, routeStreamingRequest, computeCost } from '@orchestrator/model-router';
import { debitCredits } from '@orchestrator/billing';

export async function responsesRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * POST /v1/responses — The Agent API workhorse endpoint.
   */
  fastify.post('/v1/responses', async (request: FastifyRequest, reply: FastifyReply) => {
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
    agentRequest.user_id = userId;

    // Handle streaming
    if (agentRequest.stream) {
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      let streamedModelId = agentRequest.model ?? '';
      let streamInputTokens = 0;
      let streamOutputTokens = 0;

      try {
        const stream = routeStreamingRequest(agentRequest);
        for await (const chunk of stream) {
          // Track model fallbacks
          if (chunk.type === 'model_fallback' && chunk.data && typeof chunk.data === 'object') {
            const fb = chunk.data as { actual?: string };
            if (fb.actual) streamedModelId = fb.actual;
          }
          // Capture usage for billing
          if (chunk.type === 'usage' && chunk.data && typeof chunk.data === 'object') {
            const u = chunk.data as { prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number };
            streamInputTokens = u.prompt_tokens ?? u.input_tokens ?? streamInputTokens;
            streamOutputTokens = u.completion_tokens ?? u.output_tokens ?? streamOutputTokens;
          }
          reply.raw.write(`event: ${chunk.type}\ndata: ${JSON.stringify(chunk)}\n\n`);
        }
      } catch (err) {
        try {
          reply.raw.write(
            `event: error\ndata: ${JSON.stringify({ type: 'error', data: { message: getErrorMessage(err) } })}\n\n`
          );
        } catch {
          // Connection already closed; nothing we can do
        }
      }

      try { reply.raw.end(); } catch { /* already closed */ }

      // Debit credits for streaming usage (non-blocking)
      if (streamInputTokens > 0 || streamOutputTokens > 0) {
        try {
          const costInfo = computeCost(streamedModelId, streamInputTokens, streamOutputTokens);
          if (costInfo.total_cost > 0) {
            debitCredits(userId, costInfo.total_cost, `Streaming response: ${streamedModelId}`, 'response', crypto.randomUUID(), {
              model: streamedModelId,
              input_tokens: streamInputTokens,
              output_tokens: streamOutputTokens,
            }).catch((err: unknown) => {
              logger.error({ userId, error: getErrorMessage(err) }, 'Failed to debit streaming credits');
            });
          }
        } catch (err) {
          logger.warn({ userId, error: getErrorMessage(err) }, 'Failed to compute streaming cost (non-critical)');
        }
      }

      return;
    }

    // Non-streaming
    const response = await routeRequest(agentRequest);

    // Debit credits
    if (response.usage.cost.total_cost > 0) {
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
      ).catch((err: unknown) => {
        // Log but don't fail the request if billing fails
        logger.error({ userId, error: getErrorMessage(err) }, 'Failed to debit credits');
      });
    }

    try {
      getDb()
        .prepare(`INSERT INTO audit_log (id, user_id, action, details) VALUES (?, ?, ?, ?)`)
        .run(
          crypto.randomUUID(),
          userId,
          'api_response',
          JSON.stringify({
            model: response.model,
            tokens: response.usage.total_tokens,
            cost: response.usage.cost.total_cost,
          })
        );
    } catch (err) {
      logger.warn({ userId, error: getErrorMessage(err) }, 'Audit log write failed (non-critical)');
    }

    return response;
  });
}
