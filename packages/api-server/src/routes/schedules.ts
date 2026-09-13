import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getDb, InvalidRequestError, getErrorMessage, logger } from '@orchestrator/shared';
import { getNextRun, planWorkflow, executeWorkflowToCompletion } from '@orchestrator/orchestrator';
import type { WorkflowConfig } from '@orchestrator/shared';

const ScheduleBodySchema = z
  .object({
    objective: z.string().trim().min(1),
    schedule_type: z.enum(['cron', 'interval']).default('cron'),
    cron_expression: z.string().trim().min(1).optional(),
    interval_value: z.number().int().positive().optional(),
    interval_unit: z.enum(['minutes', 'hours', 'days', 'weeks', 'months']).optional(),
    timezone: z.string().trim().min(1).default('UTC'),
    overlap_policy: z.enum(['skip', 'queue']).default('skip'),
    start_at: z.string().datetime().optional(),
    end_at: z.string().datetime().optional(),
    chat_id: z.string().optional(),
    orchestrator_model: z.string().optional(),
    model_overrides: z.record(z.string()).optional(),
    working_directory: z.string().optional(),
    human_approval: z.boolean().optional(),
    max_credits: z.number().positive().optional(),
    tools: z.array(z.string()).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.schedule_type === 'cron' && !value.cron_expression) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'cron_expression is required for cron schedules' });
    }
    if (value.schedule_type === 'interval') {
      if (!value.interval_value) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'interval_value is required for interval schedules' });
      }
      if (!value.interval_unit) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'interval_unit is required for interval schedules' });
      }
    }
  });

const SchedulePatchSchema = z.object({
  status: z.enum(['active', 'paused']).optional(),
  cron_expression: z.string().trim().min(1).optional(),
  interval_value: z.number().int().positive().optional(),
  interval_unit: z.enum(['minutes', 'hours', 'days', 'weeks', 'months']).optional(),
  timezone: z.string().trim().min(1).optional(),
  overlap_policy: z.enum(['skip', 'queue']).optional(),
  start_at: z.string().datetime().nullable().optional(),
  end_at: z.string().datetime().nullable().optional(),
});

export async function schedulesRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /v1/schedules - list user's schedules
  fastify.get('/v1/schedules', async (request: FastifyRequest) => {
    const user = request.user!;
    const db = getDb();
    const schedules = db
      .prepare(`SELECT * FROM scheduled_workflows WHERE user_id = ? AND status != 'deleted' ORDER BY created_at DESC`)
      .all(user.id);
    return { schedules };
  });

  // POST /v1/schedules - create a schedule
  fastify.post('/v1/schedules', async (request: FastifyRequest) => {
    const user = request.user!;
    const parsed = ScheduleBodySchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      throw new InvalidRequestError(firstError?.message ?? 'Invalid schedule payload', firstError?.path?.join('.'));
    }
    const body = parsed.data;

    // Validate cron expression
    let nextRun: Date;
    try {
      nextRun = getNextRun({
        scheduleType: body.schedule_type,
        cronExpression: body.cron_expression,
        intervalValue: body.interval_value,
        intervalUnit: body.interval_unit,
        timezone: body.timezone,
        startAt: body.start_at,
      });
    } catch {
      throw new InvalidRequestError('Invalid cron expression');
    }

    const {
      cron_expression,
      schedule_type,
      interval_value,
      interval_unit,
      timezone,
      overlap_policy,
      start_at,
      end_at,
      ...workflowConfig
    } = body;
    const id = crypto.randomUUID();
    const db = getDb();

    db.prepare(
      `
      INSERT INTO scheduled_workflows (
        id, user_id, cron_expression, schedule_type, interval_value, interval_unit,
        timezone, overlap_policy, start_at, end_at, workflow_config, next_run_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    ).run(
      id,
      user.id,
      cron_expression ?? null,
      schedule_type,
      interval_value ?? null,
      interval_unit ?? null,
      timezone,
      overlap_policy,
      start_at ?? null,
      end_at ?? null,
      JSON.stringify(workflowConfig),
      nextRun.toISOString()
    );

    return {
      id,
      cron_expression: cron_expression ?? null,
      schedule_type,
      interval_value: interval_value ?? null,
      interval_unit: interval_unit ?? null,
      timezone,
      overlap_policy,
      next_run_at: nextRun.toISOString(),
      status: 'active',
    };
  });

  // GET /v1/schedules/:id
  fastify.get('/v1/schedules/:id', async (request: FastifyRequest) => {
    const user = request.user!;
    const { id } = request.params as { id: string };
    const db = getDb();
    const schedule = db.prepare(`SELECT * FROM scheduled_workflows WHERE id = ? AND user_id = ?`).get(id, user.id);
    if (!schedule) throw new InvalidRequestError('Schedule not found');
    return schedule;
  });

  // PATCH /v1/schedules/:id
  fastify.patch('/v1/schedules/:id', async (request: FastifyRequest) => {
    const user = request.user!;
    const { id } = request.params as { id: string };
    const parsed = SchedulePatchSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      throw new InvalidRequestError(firstError?.message ?? 'Invalid schedule patch', firstError?.path?.join('.'));
    }
    const body = parsed.data;
    const db = getDb();

    const schedule = db.prepare(`SELECT * FROM scheduled_workflows WHERE id = ? AND user_id = ?`).get(id, user.id);
    if (!schedule) throw new InvalidRequestError('Schedule not found');

    const updates: string[] = ["updated_at = datetime('now')"];
    const values: unknown[] = [];

    if (body.status && ['active', 'paused'].includes(body.status)) {
      updates.push('status = ?');
      values.push(body.status);
    }

    const current = schedule as {
      schedule_type: 'cron' | 'interval';
      cron_expression: string | null;
      interval_value: number | null;
      interval_unit: 'minutes' | 'hours' | 'days' | 'weeks' | 'months' | null;
      timezone: string;
      start_at: string | null;
    };

    const nextScheduleType = current.schedule_type;
    const nextCron = body.cron_expression ?? current.cron_expression;
    const nextIntervalValue = body.interval_value ?? current.interval_value;
    const nextIntervalUnit = body.interval_unit ?? current.interval_unit;
    const nextTimezone = body.timezone ?? current.timezone;
    const nextStartAt = body.start_at === null ? null : (body.start_at ?? current.start_at);

    if (
      body.cron_expression !== undefined ||
      body.interval_value !== undefined ||
      body.interval_unit !== undefined ||
      body.timezone !== undefined ||
      body.start_at !== undefined
    ) {
      const nextRun = getNextRun({
        scheduleType: nextScheduleType,
        cronExpression: nextCron ?? undefined,
        intervalValue: nextIntervalValue ?? undefined,
        intervalUnit: nextIntervalUnit ?? undefined,
        timezone: nextTimezone,
        startAt: nextStartAt ?? undefined,
      });
      updates.push(
        'cron_expression = ?',
        'interval_value = ?',
        'interval_unit = ?',
        'timezone = ?',
        'start_at = ?',
        'next_run_at = ?'
      );
      values.push(
        nextCron ?? null,
        nextIntervalValue ?? null,
        nextIntervalUnit ?? null,
        nextTimezone,
        nextStartAt ?? null,
        nextRun.toISOString()
      );
    }

    if (body.overlap_policy) {
      updates.push('overlap_policy = ?');
      values.push(body.overlap_policy);
    }
    if (body.end_at !== undefined) {
      updates.push('end_at = ?');
      values.push(body.end_at ?? null);
    }

    values.push(id, user.id);
    db.prepare(`UPDATE scheduled_workflows SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`).run(...values);

    return { success: true };
  });

  // POST /v1/schedules/:id/trigger — manually trigger a scheduled workflow immediately
  fastify.post('/v1/schedules/:id/trigger', async (request: FastifyRequest) => {
    const user = request.user!;
    const { id } = request.params as { id: string };
    const db = getDb();

    const schedule = db
      .prepare(`SELECT * FROM scheduled_workflows WHERE id = ? AND user_id = ? AND status != 'deleted'`)
      .get(id, user.id) as
      | {
          id: string;
          user_id: string;
          workflow_config: string;
          overlap_policy: 'skip' | 'queue';
          active_workflow_id: string | null;
          run_count: number;
        }
      | undefined;

    if (!schedule) {
      throw new InvalidRequestError('Schedule not found');
    }

    if (schedule.overlap_policy === 'skip' && schedule.active_workflow_id) {
      return { status: 'skipped', reason: 'active_workflow_running', active_workflow_id: schedule.active_workflow_id };
    }

    const config = JSON.parse(schedule.workflow_config) as WorkflowConfig;
    const executionId = `manual:${schedule.id}:${schedule.run_count + 1}`;

    db.prepare(
      `UPDATE scheduled_workflows SET last_run_at = datetime('now'), run_count = run_count + 1, active_workflow_id = ?, last_run_status = 'running', last_error = NULL, updated_at = datetime('now') WHERE id = ?`
    ).run(executionId, id);

    // Execute in background
    void (async () => {
      try {
        const workflow = await planWorkflow(schedule.user_id, config);
        db.prepare(
          `UPDATE scheduled_workflows SET active_workflow_id = ?, updated_at = datetime('now') WHERE id = ?`
        ).run(workflow.workflowId, id);
        await executeWorkflowToCompletion(workflow.workflowId);
        db.prepare(
          `UPDATE scheduled_workflows SET active_workflow_id = NULL, last_run_status = 'completed', updated_at = datetime('now') WHERE id = ? AND active_workflow_id IN (?, ?)`
        ).run(id, workflow.workflowId, executionId);
      } catch (err) {
        logger.error({ scheduleId: id, error: getErrorMessage(err) }, 'Manually triggered schedule execution failed');
        db.prepare(
          `UPDATE scheduled_workflows SET active_workflow_id = NULL, last_run_status = 'failed', last_error = ?, updated_at = datetime('now') WHERE id = ?`
        ).run(getErrorMessage(err), id);
      }
    })();

    return { status: 'triggered', schedule_id: id };
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
