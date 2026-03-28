import type { FastifyInstance, FastifyRequest } from 'fastify';
import { listFilesByDay, registerFileInIndex } from '@orchestrator/shared';
import { z } from 'zod';

export async function filesRoutes(fastify: FastifyInstance) {
  // List all files grouped by day
  fastify.get('/v1/files', async (request: FastifyRequest) => {
    const userId = request.user!.id;
    const limit = Number((request.query as Record<string, string>).limit) || 200;
    const groups = listFilesByDay(userId, Math.min(limit, 1000));
    return { groups };
  });

  // Manual file registration (for backfill or external file writes)
  const RegisterSchema = z.object({
    workflow_id: z.string(),
    file_path: z.string(),
    file_name: z.string().optional(),
    size_bytes: z.number().optional(),
  });

  fastify.post('/v1/files/register', async (request: FastifyRequest) => {
    const parsed = RegisterSchema.safeParse(request.body);
    if (!parsed.success) {
      return { error: 'Invalid request', details: parsed.error.flatten() };
    }
    const { workflow_id, file_path, size_bytes } = parsed.data;
    registerFileInIndex(request.user!.id, workflow_id, file_path, size_bytes ?? 0);
    return { registered: true, file_path };
  });
}
