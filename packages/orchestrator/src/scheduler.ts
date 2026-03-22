/**
 * Scheduler for recurring workflows.
 * Polls every 60 seconds for due scheduled workflows and executes them.
 */
import { createRequire } from 'node:module';
import { getDb, logger, getErrorMessage, getEnv } from '@orchestrator/shared';
import type { WorkflowConfig } from '@orchestrator/shared';
import { getBalance } from '@orchestrator/billing';
import { planWorkflow, executeWorkflowToCompletion } from './engine.js';

// cron-parser is CJS-only; use createRequire to load it in ESM context
const _require = createRequire(import.meta.url);
const { parseExpression } = _require('cron-parser') as {
  parseExpression: (expr: string) => { next: () => { toDate: () => Date } };
};

export function getNextRun(cronExpression: string): Date {
  const interval = parseExpression(cronExpression);
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
    cron_expression: string;
    workflow_config: string;
    run_count: number;
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
      const nextRun = getNextRun(schedule.cron_expression);

      // Update next run time immediately to prevent double-execution
      db.prepare(`
        UPDATE scheduled_workflows
        SET last_run_at = datetime('now'), next_run_at = ?, run_count = run_count + 1, last_error = NULL, updated_at = datetime('now')
        WHERE id = ?
      `).run(nextRun.toISOString(), schedule.id);

      // Execute in background (don't await)
      void (async () => {
        try {
          const workflow = await planWorkflow(schedule.user_id, config);
          await executeWorkflowToCompletion(workflow.workflowId);
        } catch (err) {
          logger.error({ scheduleId: schedule.id, error: getErrorMessage(err) }, 'Scheduled workflow execution failed');
          db.prepare(`UPDATE scheduled_workflows SET last_error = ?, updated_at = datetime('now') WHERE id = ?`)
            .run(getErrorMessage(err), schedule.id);
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
