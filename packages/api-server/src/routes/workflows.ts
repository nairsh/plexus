import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  WorkflowConfigSchema,
  WorkflowApprovalSchema,
  PaginationSchema,
  InvalidRequestError,
  WorkflowError,
  logger,
} from '@orchestrator/shared';
import type { WorkflowEvent } from '@orchestrator/shared';
import {
  planWorkflow,
  executeWorkflow,
  cancelWorkflow,
  resumeWorkflow,
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
      } catch {
        // Non-critical
      }

      const { workflowId, plan } = await planWorkflow(userId, config);

      // If not background, start execution immediately (fire and forget)
      if (!config.background) {
        // Start execution in background — events will be emitted
        (async () => {
          try {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            for await (const _event of executeWorkflow(workflowId)) {
              // Events are emitted — SSE consumers will pick them up
            }
          } catch (err) {
            logger.error({ workflowId, error: (err as Error).message }, 'Background workflow execution failed');
          }
        })();
      }

      reply.status(201);
      return {
        workflow_id: workflowId,
        status: 'executing',
        created_at: new Date().toISOString(),
        plan: {
          task_count: plan.tasks.length,
          tasks: plan.tasks.map((t) => ({
            id: t.task_id,
            type: t.task_type,
            description: t.description,
            depends_on: t.parent_task_ids,
          })),
        },
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

      const result = listWorkflows(userId, {
        page: query.data.page,
        limit: query.data.limit,
        status: query.data.status,
      });

      return {
        workflows: result.workflows,
        total: result.total,
        page: query.data.page,
        limit: query.data.limit,
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
      });

      const listener = (event: WorkflowEvent) => {
        reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);

        // Close connection on terminal events
        if (event.type === 'workflow_completed' || event.type === 'workflow_failed') {
          setTimeout(() => {
            reply.raw.end();
          }, 100);
        }
      };

      emitter.on('event', listener);

      // Clean up on client disconnect
      request.raw.on('close', () => {
        emitter.off('event', listener);
      });

      // Keep connection alive with heartbeat
      const heartbeat = setInterval(() => {
        try {
          reply.raw.write(': heartbeat\n\n');
        } catch {
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

      // If approved, restart execution
      if (approved) {
        (async () => {
          try {
            for await (const _event of executeWorkflow(id)) {
              // Events are emitted
            }
          } catch (err) {
            logger.error({ workflowId: id, error: (err as Error).message }, 'Workflow execution failed after approval');
          }
        })();
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
      } catch {
        // Non-critical
      }

      reply.status(200);
      return { status: 'cancelled', workflow_id: id };
    }
  );
}
