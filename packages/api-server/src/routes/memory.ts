import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { InvalidRequestError } from '@orchestrator/shared';
import { saveMemory, listMemories, deleteMemory } from '@orchestrator/memory';

export async function memoryRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /v1/memory?query=&category=
   */
  fastify.get(
    '/v1/memory',
    async (request: FastifyRequest<{ Querystring: { query?: string; category?: string } }>) => {
      const user = request.user!;
      const { category } = request.query;
      const memories = listMemories(user.id, category);
      return { memories };
    }
  );

  /**
   * POST /v1/memory  body: {key, content, category?}
   */
  fastify.post('/v1/memory', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { key?: string; content?: string; category?: string } | null;
    if (!body || typeof body.key !== 'string' || typeof body.content !== 'string') {
      throw new InvalidRequestError('Request body must include "key" (string) and "content" (string)');
    }

    const user = request.user!;
    const memory = saveMemory(user.id, {
      key: body.key,
      content: body.content,
      category: typeof body.category === 'string' ? body.category : undefined,
    });

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
