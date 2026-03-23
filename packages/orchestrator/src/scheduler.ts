/**
 * Scheduler for recurring workflows.
 * Polls every 60 seconds for due scheduled workflows and executes them.
 */
import { createRequire } from 'node:module';
import { getDb, logger, getErrorMessage, getEnv } from '@orchestrator/shared';
import type { ScheduleIntervalUnit, ScheduleType, WorkflowConfig } from '@orchestrator/shared';
import { getBalance } from '@orchestrator/billing';
import { planWorkflow, executeWorkflowToCompletion } from './engine.js';

// cron-parser is CJS-only; use createRequire to load it in ESM context
const _require = createRequire(import.meta.url);
const { parseExpression } = _require('cron-parser') as {
  parseExpression: (
    expr: string,
    options?: { currentDate?: Date; tz?: string }
  ) => { next: () => { toDate: () => Date } };
};

export interface GetNextRunOptions {
  scheduleType: ScheduleType;
  cronExpression?: string;
  intervalValue?: number;
  intervalUnit?: ScheduleIntervalUnit;
  timezone?: string;
  startAt?: string;
  from?: Date;
}

const INTERVAL_MS: Record<Exclude<ScheduleIntervalUnit, 'months'>, number> = {
  minutes: 60_000,
  hours: 60 * 60_000,
  days: 24 * 60 * 60_000,
  weeks: 7 * 24 * 60 * 60_000,
};

const assertTimezone = (timezone?: string): string | undefined => {
  if (!timezone) return undefined;
  new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  return timezone;
};

const addMonths = (date: Date, months: number): Date => {
  const next = new Date(date);
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
};

const getNextIntervalRun = ({
  intervalValue,
  intervalUnit,
  startAt,
  from,
}: Required<Pick<GetNextRunOptions, 'intervalValue' | 'intervalUnit'>> & Pick<GetNextRunOptions, 'startAt' | 'from'>): Date => {
  const now = from ?? new Date();
  const anchor = startAt ? new Date(startAt) : now;
  if (Number.isNaN(anchor.getTime())) {
    throw new Error('Invalid interval start time');
  }
  if (anchor > now) {
    return anchor;
  }
  if (intervalUnit === 'months') {
    let next = anchor;
    while (next <= now) {
      next = addMonths(next, intervalValue);
    }
    return next;
  }
  const step = INTERVAL_MS[intervalUnit] * intervalValue;
  const elapsed = now.getTime() - anchor.getTime();
  const steps = Math.floor(elapsed / step) + 1;
  return new Date(anchor.getTime() + step * steps);
};

export function getNextRun(input: string | GetNextRunOptions): Date {
  if (typeof input === 'string') {
    const interval = parseExpression(input, { currentDate: new Date() });
    return interval.next().toDate();
  }

  const timezone = assertTimezone(input.timezone);
  const from = input.from ?? new Date();

  if (input.scheduleType === 'interval') {
    if (!input.intervalValue || !input.intervalUnit) {
      throw new Error('Interval schedules require intervalValue and intervalUnit');
    }
    return getNextIntervalRun({
      intervalValue: input.intervalValue,
      intervalUnit: input.intervalUnit,
      startAt: input.startAt,
      from,
    });
  }

  if (!input.cronExpression) {
    throw new Error('Cron schedules require cronExpression');
  }

  const currentDate = input.startAt ? new Date(Math.max(from.getTime(), new Date(input.startAt).getTime())) : from;
  if (Number.isNaN(currentDate.getTime())) {
    throw new Error('Invalid cron start time');
  }

  const interval = parseExpression(input.cronExpression, {
    currentDate,
    ...(timezone ? { tz: timezone } : {}),
  });
  return interval.next().toDate();
}

let schedulerInterval: ReturnType<typeof setInterval> | null = null;

async function runDueSchedules(): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();

  const dueSchedules = db.prepare(`
    SELECT * FROM scheduled_workflows
    WHERE status = 'active' AND (next_run_at IS NULL OR next_run_at <= ?)
    LIMIT 10
  `).all(now) as Array<{
    id: string;
    user_id: string;
    cron_expression: string | null;
    schedule_type: ScheduleType;
    interval_value: number | null;
    interval_unit: ScheduleIntervalUnit | null;
    timezone: string;
    start_at: string | null;
    end_at: string | null;
    overlap_policy: 'skip' | 'queue';
    workflow_config: string;
    run_count: number;
    active_workflow_id: string | null;
  }>;

  for (const schedule of dueSchedules) {
    try {
      if (getEnv().BILLING_MODE === 'enforced') {
        const balance = getBalance(schedule.user_id);
        if (balance < 0.01) {
          db
            .prepare(`UPDATE scheduled_workflows SET last_error = ?, updated_at = datetime('now') WHERE id = ?`)
            .run('Insufficient credits', schedule.id);
          continue;
        }
      }

      const config = JSON.parse(schedule.workflow_config) as WorkflowConfig;
      if (schedule.end_at && new Date(schedule.end_at).getTime() <= Date.now()) {
        db.prepare(`UPDATE scheduled_workflows SET status = 'paused', updated_at = datetime('now') WHERE id = ?`).run(schedule.id);
        continue;
      }

      if (schedule.overlap_policy === 'skip' && schedule.active_workflow_id) {
        continue;
      }

      const nextRun = getNextRun({
        scheduleType: schedule.schedule_type,
        cronExpression: schedule.cron_expression ?? undefined,
        intervalValue: schedule.interval_value ?? undefined,
        intervalUnit: schedule.interval_unit ?? undefined,
        timezone: schedule.timezone,
        startAt: schedule.start_at ?? undefined,
      });

      // Update next run time immediately to prevent double-execution
      db.prepare(`
        UPDATE scheduled_workflows
        SET last_run_at = datetime('now'), next_run_at = ?, run_count = run_count + 1, last_error = NULL, active_workflow_id = ?, last_run_status = 'running', updated_at = datetime('now')
        WHERE id = ?
      `).run(nextRun.toISOString(), `scheduled:${schedule.id}:${schedule.run_count + 1}`, schedule.id);

      // Execute in background (don't await)
      void (async () => {
        const executionId = `scheduled:${schedule.id}:${schedule.run_count + 1}`;
        try {
          const workflow = await planWorkflow(schedule.user_id, config);
          db.prepare(`UPDATE scheduled_workflows SET active_workflow_id = ?, updated_at = datetime('now') WHERE id = ?`).run(
            workflow.workflowId,
            schedule.id
          );
          await executeWorkflowToCompletion(workflow.workflowId);
          db.prepare(`
            UPDATE scheduled_workflows
            SET active_workflow_id = NULL, last_run_status = 'completed', updated_at = datetime('now')
            WHERE id = ? AND active_workflow_id IN (?, ?)
          `).run(schedule.id, workflow.workflowId, executionId);
        } catch (err) {
          logger.error({ scheduleId: schedule.id, error: getErrorMessage(err) }, 'Scheduled workflow execution failed');
          db.prepare(`
            UPDATE scheduled_workflows
            SET active_workflow_id = NULL, last_run_status = 'failed', last_error = ?, updated_at = datetime('now')
            WHERE id = ?
          `).run(getErrorMessage(err), schedule.id);
        }
      })();
    } catch (err) {
      logger.error({ scheduleId: schedule.id, error: getErrorMessage(err) }, 'Failed to process scheduled workflow');
    }
  }
}

export function startScheduler(): void {
  if (schedulerInterval) return;
  logger.info('Workflow scheduler started');
  schedulerInterval = setInterval(() => {
    void runDueSchedules().catch((err: unknown) => {
      logger.error({ error: getErrorMessage(err) }, 'Scheduler tick failed');
    });
  }, 60_000);
}

export function stopScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    logger.info('Workflow scheduler stopped');
  }
}
