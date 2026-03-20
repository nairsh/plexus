import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getDb, InvalidRequestError } from '@orchestrator/shared';
import { getNextRun } from '@orchestrator/orchestrator';

export async function schedulesRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /v1/schedules - list user's schedules
  fastify.get('/v1/schedules', async (request: FastifyRequest) => {
    const user = request.user!;
    const db = getDb();
    const schedules = db.prepare(
      `SELECT * FROM scheduled_workflows WHERE user_id = ? AND status != 'deleted' ORDER BY created_at DESC`
    ).all(user.id);
    return { schedules };
  });

  // POST /v1/schedules - create a schedule
  fastify.post('/v1/schedules', async (request: FastifyRequest) => {
    const user = request.user!;
    const body = request.body as { cron_expression?: string; objective?: string; [key: string]: unknown };

    if (!body.cron_expression || !body.objective) {
      throw new InvalidRequestError('cron_expression and objective are required');
    }

    // Validate cron expression
    let nextRun: Date;
    try {
      nextRun = getNextRun(body.cron_expression);
    } catch {
      throw new InvalidRequestError('Invalid cron expression');
    }

    const { cron_expression, ...workflowConfig } = body;
    const id = crypto.randomUUID();
    const db = getDb();

    db.prepare(`
      INSERT INTO scheduled_workflows (id, user_id, cron_expression, workflow_config, next_run_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, user.id, cron_expression, JSON.stringify(workflowConfig), nextRun.toISOString());

    return { id, cron_expression, next_run_at: nextRun.toISOString(), status: 'active' };
  });

  // GET /v1/schedules/:id
  fastify.get('/v1/schedules/:id', async (request: FastifyRequest) => {
    const user = request.user!;
    const { id } = request.params as { id: string };
    const db = getDb();
    const schedule = db.prepare(
      `SELECT * FROM scheduled_workflows WHERE id = ? AND user_id = ?`
    ).get(id, user.id);
    if (!schedule) throw new InvalidRequestError('Schedule not found');
    return schedule;
  });

  // PATCH /v1/schedules/:id
  fastify.patch('/v1/schedules/:id', async (request: FastifyRequest) => {
    const user = request.user!;
    const { id } = request.params as { id: string };
    const body = request.body as { status?: string; cron_expression?: string };
    const db = getDb();

    const schedule = db.prepare(
      `SELECT * FROM scheduled_workflows WHERE id = ? AND user_id = ?`
    ).get(id, user.id);
    if (!schedule) throw new InvalidRequestError('Schedule not found');

    const updates: string[] = ["updated_at = datetime('now')"];
    const values: unknown[] = [];

    if (body.status && ['active', 'paused'].includes(body.status)) {
      updates.push('status = ?');
      values.push(body.status);
    }
    if (body.cron_expression) {
      const nextRun = getNextRun(body.cron_expression);
      updates.push('cron_expression = ?', 'next_run_at = ?');
      values.push(body.cron_expression, nextRun.toISOString());
    }

    values.push(id, user.id);
    db.prepare(`UPDATE scheduled_workflows SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`).run(...values);

    return { success: true };
  });

  // DELETE /v1/schedules/:id
  fastify.delete('/v1/schedules/:id', async (request: FastifyRequest) => {
    const user = request.user!;
    const { id } = request.params as { id: string };
    const db = getDb();
    db.prepare(
      `UPDATE scheduled_workflows SET status = 'deleted', updated_at = datetime('now') WHERE id = ? AND user_id = ?`
    ).run(id, user.id);
    return { success: true };
  });
}
