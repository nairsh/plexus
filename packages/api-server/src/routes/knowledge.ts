import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { InvalidRequestError } from '@orchestrator/shared';
import {
  deleteKnowledgeDocumentForUser,
  getKnowledgeDocumentForUser,
  ingestKnowledgeDocument,
  listKnowledgeDocumentsForUser,
  searchKnowledgeForUser,
} from '@orchestrator/model-router';

const KnowledgeUploadSchema = z.object({
  filename: z.string().trim().min(1),
  media_type: z.string().trim().min(1),
  content_base64: z.string().trim().min(1),
});

const KnowledgeSearchSchema = z.object({
  query: z.string().trim().min(1),
  limit: z.number().int().positive().max(20).optional(),
});

export async function knowledgeRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/v1/knowledge/documents', async (request: FastifyRequest) => {
    return { documents: listKnowledgeDocumentsForUser(request.user!.id) };
  });

  fastify.post('/v1/knowledge/documents', async (request: FastifyRequest) => {
    const parsed = KnowledgeUploadSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      throw new InvalidRequestError(firstError?.message ?? 'Invalid document payload', firstError?.path?.join('.'));
    }

    const document = await ingestKnowledgeDocument(request.user!.id, {
      filename: parsed.data.filename,
      mediaType: parsed.data.media_type,
      contentBase64: parsed.data.content_base64,
    });

    return { document };
  });

  fastify.get('/v1/knowledge/documents/:id', async (request: FastifyRequest<{ Params: { id: string } }>) => {
    const result = getKnowledgeDocumentForUser(request.user!.id, request.params.id);
    if (!result) {
      throw new InvalidRequestError('Knowledge document not found', 'id');
    }
    return result;
  });

  fastify.delete('/v1/knowledge/documents/:id', async (request: FastifyRequest<{ Params: { id: string } }>) => {
    const deleted = deleteKnowledgeDocumentForUser(request.user!.id, request.params.id);
    if (!deleted) {
      throw new InvalidRequestError('Knowledge document not found', 'id');
    }
    return { deleted: true, id: request.params.id };
  });

  fastify.post('/v1/knowledge/search', async (request: FastifyRequest) => {
    const parsed = KnowledgeSearchSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      throw new InvalidRequestError(firstError?.message ?? 'Invalid search payload', firstError?.path?.join('.'));
    }

    const matches = await searchKnowledgeForUser(request.user!.id, parsed.data.query, parsed.data.limit ?? 6);
    return { matches };
  });
}
