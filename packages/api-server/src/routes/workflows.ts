import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  WorkflowConfigSchema,
  WorkflowApprovalSchema,
  PaginationSchema,
  InvalidRequestError,
  WorkflowError,
  getErrorMessage,
  logger,
} from '@orchestrator/shared';
import type { WorkflowEvent } from '@orchestrator/shared';
import {
  planWorkflow,
  executeWorkflow,
  executeWorkflowToCompletion,
  cancelWorkflow,
  resumeWorkflow,
  continueWorkflow,
  getWorkflowDetails,
  getWorkflowEmitter,
  getWorkflowTrace,
  listWorkflows,
} from '@orchestrator/orchestrator';

export async function workflowRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * POST /v1/workflows — Create and start a workflow.
   */
  fastify.post(
    '/v1/workflows',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseResult = WorkflowConfigSchema.safeParse(request.body);
      if (!parseResult.success) {
        const firstError = parseResult.error.errors[0];
        throw new InvalidRequestError(
          `Validation error: ${firstError?.message ?? 'Invalid request'}`,
          firstError?.path?.join('.') ?? undefined
        );
      }

      const userId = request.user!.id;
      const config = parseResult.data;

      // Audit log
      try {
        const { getDb } = await import('@orchestrator/shared');
        const db = getDb();
        db.prepare(
          'INSERT INTO audit_log (id, user_id, action, details) VALUES (?, ?, ?, ?)'
        ).run(
          crypto.randomUUID(),
          userId,
          'workflow_create',
          JSON.stringify({ objective: config.objective.substring(0, 200) })
        );
      } catch (err) {
        logger.warn({ userId, error: getErrorMessage(err) }, 'Audit log write failed (non-critical)');
      }

      const { workflowId, tasks } = await planWorkflow(userId, config);

      // Start execution in background — events will be emitted via SSE
      if (!config.background) {
        (async () => {
          try {
            await executeWorkflowToCompletion(workflowId);
          } catch (err) {
            logger.error({ workflowId, error: getErrorMessage(err) }, 'Background workflow execution failed');
          }
        })();
      }

      reply.status(201);
      return {
        workflow_id: workflowId,
        status: 'executing',
        created_at: new Date().toISOString(),
        task_count: tasks.length,
        tasks: tasks.map((t) => ({
          id: t.task_id,
          type: t.agent_type,
          description: t.description,
          agent_type: t.agent_type,
          depends_on: t.depends_on,
        })),
      };
    }
  );

  fastify.post(
    '/v1/workflows/:id/continue',
    async (request: FastifyRequest<{ Params: { id: string }; Body: { objective?: string } }>) => {
      const { id } = request.params;
      const objective = request.body?.objective?.trim();

      if (!objective) {
        throw new InvalidRequestError('objective is required');
      }

      const result = await continueWorkflow(id, objective);
      const stream = executeWorkflow(id);
      void stream.done.catch((error) => {
        logger.error({ workflowId: id, error: getErrorMessage(error) }, 'Workflow continuation execution failed');
      });

      return {
        workflow_id: result.workflowId,
        status: 'executing',
      };
    }
  );

  /**
   * GET /v1/workflows — List user's workflows.
   */
  fastify.get(
    '/v1/workflows',
    async (request: FastifyRequest<{ Querystring: { page?: string; limit?: string; status?: string } }>) => {
      const userId = request.user!.id;
      const query = PaginationSchema.safeParse(request.query);
      if (!query.success) {
        throw new InvalidRequestError('Invalid pagination parameters');
      }

      const all = listWorkflows(userId);
      const page = query.data.page;
      const limit = query.data.limit;
      const status = query.data.status;

      const filtered = status ? all.filter((workflow) => workflow.status === status) : all;
      const start = (page - 1) * limit;
      const workflows = filtered.slice(start, start + limit);

      return {
        workflows,
        total: filtered.length,
        page,
        limit,
      };
    }
  );

  /**
   * GET /v1/workflows/:id — Get workflow details.
   */
  fastify.get(
    '/v1/workflows/:id',
    async (request: FastifyRequest<{ Params: { id: string } }>) => {
      const { id } = request.params;
      const details = getWorkflowDetails(id);
      if (!details) {
        throw new WorkflowError(`Workflow not found: ${id}`, 'workflow_not_found');
      }
      return details;
    }
  );

  fastify.get(
    '/v1/workflows/:id/trace',
    async (request: FastifyRequest<{ Params: { id: string } }>) => {
      const { id } = request.params;
      const details = getWorkflowDetails(id);
      if (!details) {
        throw new WorkflowError(`Workflow not found: ${id}`, 'workflow_not_found');
      }

      return {
        workflow_id: id,
        trace: getWorkflowTrace(id),
      };
    }
  );

  /**
   * GET /v1/workflows/:id/stream — SSE stream of workflow events.
   */
  fastify.get(
    '/v1/workflows/:id/stream',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = request.params;
      const emitter = getWorkflowEmitter(id);
      if (!emitter) {
        throw new WorkflowError(`Workflow not found or not active: ${id}`, 'workflow_not_found');
      }

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': request.headers.origin ?? '*',
        Vary: 'Origin',
      });

      const listener = (event: WorkflowEvent) => {
        reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);

        if (event.type === 'workflow_completed' || event.type === 'workflow_failed') {
          setTimeout(() => {
            reply.raw.end();
          }, 100);
        }
      };

      emitter.on('event', listener);

      request.raw.on('close', () => {
        emitter.off('event', listener);
      });

      const heartbeat = setInterval(() => {
        try {
          reply.raw.write(': heartbeat\n\n');
        } catch (_err) {
          // Client disconnected; stop heartbeat
          clearInterval(heartbeat);
        }
      }, 15_000);

      request.raw.on('close', () => {
        clearInterval(heartbeat);
      });
    }
  );

  /**
   * POST /v1/workflows/:id/approve — Approve or reject a pending task.
   */
  fastify.post(
    '/v1/workflows/:id/approve',
    async (request: FastifyRequest<{ Params: { id: string } }>) => {
      const { id } = request.params;
      const parseResult = WorkflowApprovalSchema.safeParse(request.body);
      if (!parseResult.success) {
        throw new InvalidRequestError('Invalid approval body. Required: { task_id, approved: boolean, feedback?: string }');
      }

      const { task_id, approved, feedback } = parseResult.data;

      await resumeWorkflow(id, [{ task_id, approved, feedback }]);

      if (approved) {
        void executeWorkflowToCompletion(id).catch((error) => {
          logger.error({ workflowId: id, error: getErrorMessage(error) }, 'Workflow execution failed after approval');
        });
      }

      return {
        status: approved ? 'resumed' : 'rejected',
        workflow_id: id,
        task_id,
      };
    }
  );

  /**
   * DELETE /v1/workflows/:id — Cancel a workflow.
   */
  fastify.delete(
    '/v1/workflows/:id',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = request.params;
      cancelWorkflow(id);

      // Audit log
      try {
        const { getDb } = await import('@orchestrator/shared');
        const db = getDb();
        db.prepare(
          'INSERT INTO audit_log (id, user_id, action, details) VALUES (?, ?, ?, ?)'
        ).run(
          crypto.randomUUID(),
          request.user!.id,
          'workflow_cancel',
          JSON.stringify({ workflow_id: id })
        );
      } catch (err) {
        logger.warn({ workflowId: id, error: getErrorMessage(err) }, 'Audit log write failed (non-critical)');
      }

      reply.status(200);
      return { status: 'cancelled', workflow_id: id };
    }
  );
}
