import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  SandboxConfigSchema,
  ExecuteCodeSchema,
  InvalidRequestError,
  SandboxError,
  logger,
} from '@orchestrator/shared';
import {
  createSession,
  execute,
  readSandboxFile,
  writeSandboxFile,
  listSandboxFiles,
  terminateSession,
  getSessionInfo,
  getWorkspaceInfo,
  readWorkspaceMetadata,
  snapshotWorkspaceFiles,
} from '@orchestrator/sandbox';

export async function sandboxRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * POST /v1/sandbox/sessions — Create a sandbox session.
   */
  fastify.post(
    '/v1/sandbox/sessions',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseResult = SandboxConfigSchema.safeParse(request.body);
      if (!parseResult.success) {
        const firstError = parseResult.error.errors[0];
        throw new InvalidRequestError(
          `Validation error: ${firstError?.message ?? 'Invalid request'}`,
          firstError?.path?.join('.') ?? undefined
        );
      }

      const userId = request.user!.id;
      const session = await createSession(userId, parseResult.data);

      // Audit log
      try {
        const { getDb } = await import('@orchestrator/shared');
        const db = getDb();
        db.prepare(
          'INSERT INTO audit_log (id, user_id, action, details) VALUES (?, ?, ?, ?)'
        ).run(
          crypto.randomUUID(),
          userId,
          'sandbox_create',
          JSON.stringify({ session_id: session.id, language: session.language })
        );
      } catch {
        // Non-critical
      }

      reply.status(201);
      return session;
    }
  );

  /**
   * POST /v1/sandbox/sessions/:id/execute — Execute code in a session.
   */
  fastify.post(
    '/v1/sandbox/sessions/:id/execute',
    async (request: FastifyRequest<{ Params: { id: string } }>) => {
      const { id } = request.params;
      const parseResult = ExecuteCodeSchema.safeParse(request.body);
      if (!parseResult.success) {
        throw new InvalidRequestError(
          'Invalid request body. Required: { code: string, timeout_seconds?: number }'
        );
      }

      const result = await execute(id, parseResult.data.code, parseResult.data.timeout_seconds);

      // Audit log
      try {
        const { getDb } = await import('@orchestrator/shared');
        const db = getDb();
        db.prepare(
          'INSERT INTO audit_log (id, user_id, action, details) VALUES (?, ?, ?, ?)'
        ).run(
          crypto.randomUUID(),
          request.user!.id,
          'sandbox_execute',
          JSON.stringify({
            session_id: id,
            exit_code: result.exit_code,
            execution_time_ms: result.execution_time_ms,
          })
        );
      } catch {
        // Non-critical
      }

      return result;
    }
  );

  /**
   * GET /v1/sandbox/sessions/:id/files — List files in a session workspace.
   */
  fastify.get(
    '/v1/sandbox/sessions/:id/files',
    async (request: FastifyRequest<{ Params: { id: string }; Querystring: { directory?: string } }>) => {
      const { id } = request.params;
      const directory = request.query.directory;
      const files = await listSandboxFiles(id, directory);
      return { files };
    }
  );

  /**
   * GET /v1/sandbox/sessions/:id/files/* — Read a file from the session.
   */
  fastify.get(
    '/v1/sandbox/sessions/:id/file/*',
    async (request: FastifyRequest<{ Params: { id: string; '*': string } }>, reply: FastifyReply) => {
      const { id } = request.params;
      const filePath = request.params['*'];
      if (!filePath) {
        throw new InvalidRequestError('File path is required');
      }

      const content = await readSandboxFile(id, filePath);

      // Try to determine content type
      const ext = filePath.split('.').pop()?.toLowerCase();
      const contentTypes: Record<string, string> = {
        json: 'application/json',
        txt: 'text/plain',
        py: 'text/plain',
        js: 'text/plain',
        ts: 'text/plain',
        html: 'text/html',
        css: 'text/css',
        csv: 'text/csv',
        md: 'text/markdown',
        png: 'image/png',
        jpg: 'image/jpeg',
        svg: 'image/svg+xml',
        pdf: 'application/pdf',
      };

      const contentType = (ext && contentTypes[ext]) || 'application/octet-stream';
      reply.header('Content-Type', contentType);
      return reply.send(content);
    }
  );

  /**
   * PUT /v1/sandbox/sessions/:id/file/* — Write a file to the session.
   */
  fastify.put(
    '/v1/sandbox/sessions/:id/file/*',
    async (request: FastifyRequest<{ Params: { id: string; '*': string } }>, reply: FastifyReply) => {
      const { id } = request.params;
      const filePath = request.params['*'];
      if (!filePath) {
        throw new InvalidRequestError('File path is required');
      }

      const body = request.body;
      let content: Buffer;

      if (Buffer.isBuffer(body)) {
        content = body;
      } else if (typeof body === 'string') {
        content = Buffer.from(body, 'utf-8');
      } else if (body && typeof body === 'object' && 'content_base64' in (body as Record<string, unknown>)) {
        content = Buffer.from((body as { content_base64: string }).content_base64, 'base64');
      } else if (body && typeof body === 'object' && 'content' in (body as Record<string, unknown>)) {
        content = Buffer.from((body as { content: string }).content, 'utf-8');
      } else {
        throw new InvalidRequestError(
          'Request body must be raw content, or JSON with { content: string } or { content_base64: string }'
        );
      }

      await writeSandboxFile(id, filePath, content);

      reply.status(200);
      return { status: 'ok', path: filePath };
    }
  );

  /**
   * GET /v1/sandbox/sessions/:id — Get session info.
   */
  fastify.get(
    '/v1/sandbox/sessions/:id',
    async (request: FastifyRequest<{ Params: { id: string } }>) => {
      const { id } = request.params;
      const session = getSessionInfo(id);
      if (!session) {
        throw new SandboxError(`Session not found: ${id}`, 'session_not_found');
      }
      return session;
    }
  );

  fastify.get(
    '/v1/sandbox/workspaces/:chatId',
    async (request: FastifyRequest<{ Params: { chatId: string } }>) => {
      const workspace = getWorkspaceInfo(request.params.chatId);
      if (!workspace) {
        throw new SandboxError(`Workspace not found: ${request.params.chatId}`, 'workspace_not_found');
      }

      return {
        workspace,
        metadata: readWorkspaceMetadata(request.params.chatId),
        files: snapshotWorkspaceFiles(workspace['workspace_path'] as string),
      };
    }
  );

  /**
   * DELETE /v1/sandbox/sessions/:id — Terminate a session.
   */
  fastify.delete(
    '/v1/sandbox/sessions/:id',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = request.params;
      terminateSession(id);

      // Audit log
      try {
        const { getDb } = await import('@orchestrator/shared');
        const db = getDb();
        db.prepare(
          'INSERT INTO audit_log (id, user_id, action, details) VALUES (?, ?, ?, ?)'
        ).run(
          crypto.randomUUID(),
          request.user!.id,
          'sandbox_terminate',
          JSON.stringify({ session_id: id })
        );
      } catch {
        // Non-critical
      }

      reply.status(200);
      return { status: 'terminated', session_id: id };
    }
  );
}
