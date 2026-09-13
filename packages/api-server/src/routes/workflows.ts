import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  WorkflowConfigSchema,
  WorkflowApprovalSchema,
  BashApprovalSchema,
  PaginationSchema,
  InvalidRequestError,
  WorkflowError,
  getErrorMessage,
  logger,
  getDb,
} from '@orchestrator/shared';
import type { WorkflowEvent, ToolApprovalDecision } from '@orchestrator/shared';
import { rollbackGitSandbox, getGitSandboxDiff, listGitSandboxes } from '@orchestrator/sandbox';
import {
  planWorkflow,
  executeWorkflow,
  executeWorkflowToCompletion,
  cancelWorkflow,
  resumeWorkflow,
  continueWorkflow,
  retryWorkflow,
  getWorkflowDetails,
  getWorkflowEmitter,
  getWorkflowTrace,
  listWorkflows,
  countWorkflows,
  resolveWorkflowApproval,
  getPendingApprovals,
  getWorkflowProgress,
} from '@orchestrator/orchestrator';

const ensureWorkflowOwned = (workflowId: string, userId: string): void => {
  const row = getDb().prepare('SELECT 1 FROM workflows WHERE id = ? AND user_id = ?').get(workflowId, userId) as
    | { 1: number }
    | undefined;

  if (!row) {
    throw new WorkflowError(`Workflow not found: ${workflowId}`, 'workflow_not_found');
  }
};

const ensureTaskOwned = (workflowId: string, taskId: string, userId: string): void => {
  const row = getDb()
    .prepare(
      `SELECT 1
       FROM tasks t
       JOIN workflows w ON w.id = t.workflow_id
       WHERE t.workflow_id = ? AND t.id = ? AND w.user_id = ?`
    )
    .get(workflowId, taskId, userId) as { 1: number } | undefined;

  if (!row) {
    throw new InvalidRequestError('Task not found', 'not_found');
  }
};

const ensureGitSandboxInWorkflow = (workflowId: string, sandboxId: string): void => {
  const row = getDb()
    .prepare('SELECT 1 FROM git_snapshots WHERE id = ? AND workflow_id = ?')
    .get(sandboxId, workflowId) as { 1: number } | undefined;

  if (!row) {
    throw new InvalidRequestError('Sandbox not found', 'not_found');
  }
};

export async function workflowRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * POST /v1/workflows — Create and start a workflow.
   */
  fastify.post('/v1/workflows', async (request: FastifyRequest, reply: FastifyReply) => {
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

    try {
      getDb()
        .prepare('INSERT INTO audit_log (id, user_id, action, details) VALUES (?, ?, ?, ?)')
        .run(
          crypto.randomUUID(),
          userId,
          'workflow_create',
          JSON.stringify({ objective: config.objective.substring(0, 200) })
        );
    } catch (err) {
      logger.warn({ userId, error: getErrorMessage(err) }, 'Audit log write failed (non-critical)');
    }

    const { workflowId, tasks } = await planWorkflow(userId, config);

    // Always start execution in background — events will be emitted via SSE
    void (async () => {
      try {
        await executeWorkflowToCompletion(workflowId);
      } catch (err) {
        logger.error({ workflowId, error: getErrorMessage(err) }, 'Background workflow execution failed');
      }
    })();

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
  });

  fastify.post(
    '/v1/workflows/:id/continue',
    async (request: FastifyRequest<{ Params: { id: string }; Body: { objective?: string } }>) => {
      const { id } = request.params;
      const userId = request.user!.id;
      const objective = request.body?.objective?.trim();

      ensureWorkflowOwned(id, userId);

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

      const page = query.data.page;
      const limit = query.data.limit;
      const status = query.data.status;
      const offset = (page - 1) * limit;

      const workflows = listWorkflows(userId, { status, limit, offset });
      const total = countWorkflows(userId, status);

      return {
        workflows,
        total,
        page,
        limit,
      };
    }
  );

  /**
   * GET /v1/workflows/:id — Get workflow details.
   */
  fastify.get('/v1/workflows/:id', async (request: FastifyRequest<{ Params: { id: string } }>) => {
    const { id } = request.params;
    ensureWorkflowOwned(id, request.user!.id);
    const details = getWorkflowDetails(id);
    if (!details) {
      throw new WorkflowError(`Workflow not found: ${id}`, 'workflow_not_found');
    }
    return details;
  });

  fastify.get('/v1/workflows/:id/trace', async (request: FastifyRequest<{ Params: { id: string } }>) => {
    const { id } = request.params;
    ensureWorkflowOwned(id, request.user!.id);
    const details = getWorkflowDetails(id);
    if (!details) {
      throw new WorkflowError(`Workflow not found: ${id}`, 'workflow_not_found');
    }

    return {
      workflow_id: id,
      trace: getWorkflowTrace(id),
    };
  });

  /**
   * GET /v1/workflows/:id/stream — SSE stream of workflow events.
   */
  fastify.get(
    '/v1/workflows/:id/stream',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = request.params;
      ensureWorkflowOwned(id, request.user!.id);
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': request.headers.origin ?? '*',
        Vary: 'Origin',
      });

      const emitter = getWorkflowEmitter(id);
      if (!emitter) {
        // Workflow not in memory — check DB and synthesize a completion/failure event
        const details = getWorkflowDetails(id);
        if (details) {
          const { workflow } = details;
          if (workflow.status === 'completed') {
            reply.raw.write(
              `event: workflow_completed\ndata: ${JSON.stringify({
                type: 'workflow_completed',
                workflow_id: id,
                data: { output: workflow.output ?? '', total_credits: workflow.credits_consumed },
              })}\n\n`
            );
          } else if (workflow.status === 'failed') {
            reply.raw.write(
              `event: workflow_failed\ndata: ${JSON.stringify({
                type: 'workflow_failed',
                workflow_id: id,
                data: { error: workflow.error ?? 'Workflow failed' },
              })}\n\n`
            );
          } else if (workflow.status === 'cancelled') {
            reply.raw.write(
              `event: workflow_cancelled\ndata: ${JSON.stringify({
                type: 'workflow_cancelled',
                workflow_id: id,
                data: { reason: workflow.error ?? 'Workflow cancelled' },
              })}\n\n`
            );
          }
        }
        reply.raw.end();
        return;
      }

      const heartbeat = setInterval(() => {
        try {
          reply.raw.write(': heartbeat\n\n');
        } catch (_err) {
          clearInterval(heartbeat);
        }
      }, 15_000);

      const cleanup = () => {
        clearInterval(heartbeat);
        emitter.off('event', listener);
      };

      const listener = (event: WorkflowEvent) => {
        try {
          reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        } catch (_err) {
          cleanup();
          try {
            reply.raw.end();
          } catch {
            /* already closed */
          }
          return;
        }

        if (
          event.type === 'workflow_completed' ||
          event.type === 'workflow_failed' ||
          event.type === 'workflow_cancelled'
        ) {
          cleanup();
          setTimeout(() => {
            try {
              reply.raw.end();
            } catch {
              /* already closed */
            }
          }, 100);
        }
      };

      emitter.on('event', listener);

      request.raw.on('close', cleanup);
    }
  );

  /**
   * POST /v1/workflows/:id/approve — Approve or reject a pending task.
   */
  fastify.post('/v1/workflows/:id/approve', async (request: FastifyRequest<{ Params: { id: string } }>) => {
    const { id } = request.params;
    ensureWorkflowOwned(id, request.user!.id);
    const parseResult = WorkflowApprovalSchema.safeParse(request.body);
    if (!parseResult.success) {
      throw new InvalidRequestError(
        'Invalid approval body. Required: { task_id, approved: boolean, feedback?: string }'
      );
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
  });

  /**
   * POST /v1/workflows/:id/bash-approve — resolve a pending bash command approval.
   * Body: { approval_id: string, decision: 'approve' | 'deny' | 'approve_all_session' | 'approve_command_session' }
   */
  fastify.post(
    '/v1/workflows/:id/bash-approve',
    async (request: FastifyRequest<{ Params: { id: string }; Body: unknown }>) => {
      const { id } = request.params;
      ensureWorkflowOwned(id, request.user!.id);

      const parsed = BashApprovalSchema.safeParse(request.body);
      if (!parsed.success) {
        const firstError = parsed.error.errors[0];
        throw new InvalidRequestError(
          firstError?.message ?? 'Invalid approval body',
          firstError?.path?.join('.') ?? 'approval_body'
        );
      }

      const { approval_id: approvalId, decision } = parsed.data;
      resolveWorkflowApproval(id, approvalId, decision as ToolApprovalDecision);

      return { status: 'ok', workflow_id: id, approval_id: approvalId, decision };
    }
  );

  /**
   * GET /v1/workflows/:id/progress — real-time progress summary for polling.
   * Returns task breakdown, credits consumed, and estimated completion % without SSE.
   */
  fastify.get('/v1/workflows/:id/progress', async (request: FastifyRequest<{ Params: { id: string } }>) => {
    const { id } = request.params;
    ensureWorkflowOwned(id, request.user!.id);
    const progress = getWorkflowProgress(id);
    if (!progress) {
      throw new WorkflowError(`Workflow not found: ${id}`, 'workflow_not_found');
    }
    return progress;
  });

  /**
   * GET /v1/workflows/:id/pending-approvals — list pending bash command approvals.
   * Allows clients to poll for pending approvals without maintaining an SSE connection.
   */
  fastify.get('/v1/workflows/:id/pending-approvals', async (request: FastifyRequest<{ Params: { id: string } }>) => {
    const { id } = request.params;
    ensureWorkflowOwned(id, request.user!.id);
    const pending = getPendingApprovals(id);
    return { workflow_id: id, pending_approvals: pending };
  });

  /**
   * POST /v1/workflows/:id/retry — retry a failed or cancelled workflow.
   * Resets failed tasks to pending and re-runs; preserves completed task outputs.
   */
  fastify.post('/v1/workflows/:id/retry', async (request: FastifyRequest<{ Params: { id: string } }>) => {
    const { id } = request.params;
    ensureWorkflowOwned(id, request.user!.id);
    const result = await retryWorkflow(id);

    // Run in background
    executeWorkflowToCompletion(id).catch((err: Error) => {
      logger.warn({ workflowId: id, error: getErrorMessage(err) }, 'Background retry execution failed');
    });

    return { workflow_id: id, status: 'retrying', reset_tasks: result.resetTasks };
  });

  /**
   * GET /v1/workflows/:id/tasks/:taskId — get full output for a specific task.
   * Useful for transparency/context preservation — the list endpoints only include previews.
   */
  fastify.get(
    '/v1/workflows/:id/tasks/:taskId',
    async (request: FastifyRequest<{ Params: { id: string; taskId: string } }>) => {
      const { id, taskId } = request.params;
      ensureTaskOwned(id, taskId, request.user!.id);
      const db = getDb();

      const row = db
        .prepare(
          `SELECT id AS task_id, description, task_type AS agent_type, status, output,
                         parent_task_ids, created_at, completed_at
                  FROM tasks WHERE workflow_id = ? AND id = ?`
        )
        .get(id, taskId) as
        | {
            task_id: string;
            description: string | null;
            agent_type: string;
            status: string;
            output: string | null;
            parent_task_ids: string | null;
            created_at: string;
            completed_at: string | null;
          }
        | undefined;

      if (!row) throw new InvalidRequestError('Task not found', 'not_found');

      let dependsOn: string[] = [];
      try {
        dependsOn = JSON.parse(row.parent_task_ids ?? '[]') as string[];
      } catch {
        /* ignore */
      }

      return { ...row, depends_on: dependsOn, output: row.output ?? null };
    }
  );

  /**
   * GET /v1/workflows/:id/git-sandboxes — list git sandboxes for a workflow
   */
  fastify.get('/v1/workflows/:id/git-sandboxes', async (request: FastifyRequest<{ Params: { id: string } }>) => {
    const { id } = request.params;
    ensureWorkflowOwned(id, request.user!.id);
    const sandboxes = listGitSandboxes(id);
    return { sandboxes };
  });

  /**
   * GET /v1/workflows/:id/git-sandboxes/:sandboxId/diff — get diff for a sandbox
   */
  fastify.get(
    '/v1/workflows/:id/git-sandboxes/:sandboxId/diff',
    async (request: FastifyRequest<{ Params: { id: string; sandboxId: string } }>) => {
      const { id, sandboxId } = request.params;
      ensureWorkflowOwned(id, request.user!.id);
      ensureGitSandboxInWorkflow(id, sandboxId);
      return getGitSandboxDiff(sandboxId);
    }
  );

  /**
   * POST /v1/workflows/:id/git-sandboxes/:sandboxId/rollback — roll back agent changes
   */
  fastify.post(
    '/v1/workflows/:id/git-sandboxes/:sandboxId/rollback',
    async (request: FastifyRequest<{ Params: { id: string; sandboxId: string } }>, reply: FastifyReply) => {
      const { id, sandboxId } = request.params;
      ensureWorkflowOwned(id, request.user!.id);
      ensureGitSandboxInWorkflow(id, sandboxId);
      const result = await rollbackGitSandbox(sandboxId);
      if (!result.success) {
        throw new InvalidRequestError(result.error ?? 'Rollback failed', 'rollback_failed');
      }
      return reply.status(200).send({ success: true, sandbox_id: sandboxId });
    }
  );

  /**
   * POST /v1/workflows/:id/cancel — Cancel a running or paused workflow.
   * Preserves workflow history, tasks, and traceability. Idempotent.
   */
  fastify.post(
    '/v1/workflows/:id/cancel',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = request.params;
      ensureWorkflowOwned(id, request.user!.id);
      cancelWorkflow(id);

      try {
        getDb()
          .prepare('INSERT INTO audit_log (id, user_id, action, details) VALUES (?, ?, ?, ?)')
          .run(crypto.randomUUID(), request.user!.id, 'workflow_cancel', JSON.stringify({ workflow_id: id }));
      } catch (err) {
        logger.warn({ workflowId: id, error: getErrorMessage(err) }, 'Audit log write failed (non-critical)');
      }

      reply.status(200);
      return { status: 'cancelled', workflow_id: id };
    }
  );

  /**
   * DELETE /v1/workflows/:id — Cancel a workflow (preserves history).
   * Backward-compatible alias for POST /v1/workflows/:id/cancel.
   * Does NOT delete the workflow row — cancelled workflows remain fetchable/listable.
   */
  fastify.delete(
    '/v1/workflows/:id',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = request.params;
      ensureWorkflowOwned(id, request.user!.id);
      cancelWorkflow(id);

      try {
        getDb()
          .prepare('INSERT INTO audit_log (id, user_id, action, details) VALUES (?, ?, ?, ?)')
          .run(crypto.randomUUID(), request.user!.id, 'workflow_cancel', JSON.stringify({ workflow_id: id }));
      } catch (err) {
        logger.warn({ workflowId: id, error: getErrorMessage(err) }, 'Audit log write failed (non-critical)');
      }

      reply.status(200);
      return { status: 'cancelled', workflow_id: id };
    }
  );
}
