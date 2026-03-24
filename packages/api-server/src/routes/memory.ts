import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { InvalidRequestError } from '@orchestrator/shared';
import { saveMemory, listMemories, deleteMemory } from '@orchestrator/memory';
import { z } from 'zod';

const SaveMemorySchema = z.object({
  key: z.string().min(1).max(200),
  content: z.string().min(1).max(50000),
  category: z.string().min(1).max(100).optional(),
});

export async function memoryRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /v1/memory?query=&category=
   */
  fastify.get(
    '/v1/memory',
    async (request: FastifyRequest<{ Querystring: { query?: string; category?: string; limit?: string; offset?: string } }>) => {
      const user = request.user!;
      const { category, limit: limitStr, offset: offsetStr } = request.query;
      const limit = Math.min(Math.max(parseInt(limitStr ?? '100', 10) || 100, 1), 500);
      const offset = Math.max(parseInt(offsetStr ?? '0', 10) || 0, 0);
      const memories = listMemories(user.id, category, limit, offset);
      return { memories, limit, offset };
    }
  );

  /**
   * POST /v1/memory  body: {key, content, category?}
   */
  fastify.post('/v1/memory', async (request: FastifyRequest, reply: FastifyReply) => {
    const parseResult = SaveMemorySchema.safeParse(request.body);
    if (!parseResult.success) {
      throw new InvalidRequestError(parseResult.error.errors.map((e) => e.message).join(', '));
    }

    const user = request.user!;
    const { key, content, category } = parseResult.data;
    const memory = saveMemory(user.id, { key, content, category });

    reply.status(201);
    return memory;
  });

  /**
   * DELETE /v1/memory/:id
   */
  fastify.delete(
    '/v1/memory/:id',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const user = request.user!;
      const deleted = deleteMemory(user.id, request.params.id);
      if (!deleted) {
        reply.status(404);
        return { error: 'Memory not found' };
      }
      return { deleted: true };
    }
  );
}
