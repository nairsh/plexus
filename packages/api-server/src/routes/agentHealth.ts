/**
 * Agent Health Monitoring API
 *
 * Tracks success/failure rates and latencies for each agent type.
 * Provides a dashboard-style health endpoint for monitoring.
 */
import type { FastifyInstance } from 'fastify';
import { getDb, logger } from '@orchestrator/shared';
import type { AgentHealthStatus } from '@orchestrator/shared';

// ── Health recording ──────────────────────────────────────────────────────────

interface HealthRow {
  id: string;
  agent_type: string;
  model: string;
  status: string;
  last_success_at: string | null;
  last_failure_at: string | null;
  success_count_1h: number;
  failure_count_1h: number;
  total_latency_ms_1h: number;
}

export function recordAgentSuccess(agentType: string, model: string, latencyMs: number): void {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO agent_health (id, agent_type, model, status, last_success_at, success_count_1h, total_latency_ms_1h)
      VALUES (?, ?, ?, 'healthy', datetime('now'), 1, ?)
      ON CONFLICT(agent_type, model) DO UPDATE SET
        status = 'healthy',
        last_success_at = datetime('now'),
        success_count_1h = success_count_1h + 1,
        total_latency_ms_1h = total_latency_ms_1h + excluded.total_latency_ms_1h,
        updated_at = datetime('now')
    `).run(crypto.randomUUID(), agentType, model, latencyMs);
  } catch (err) {
    logger.warn({ agentType, error: String(err) }, 'Failed to record agent health success');
  }
}

export function recordAgentFailure(agentType: string, model: string): void {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO agent_health (id, agent_type, model, status, last_failure_at, failure_count_1h)
      VALUES (?, ?, ?, 'degraded', datetime('now'), 1)
      ON CONFLICT(agent_type, model) DO UPDATE SET
        last_failure_at = datetime('now'),
        failure_count_1h = failure_count_1h + 1,
        status = CASE
          WHEN failure_count_1h + 1 >= 5 THEN 'unavailable'
          WHEN failure_count_1h + 1 >= 2 THEN 'degraded'
          ELSE 'healthy'
        END,
        updated_at = datetime('now')
    `).run(crypto.randomUUID(), agentType, model);
  } catch (err) {
    logger.warn({ agentType, error: String(err) }, 'Failed to record agent health failure');
  }
}

function toHealthStatus(row: HealthRow): AgentHealthStatus {
  const total = row.success_count_1h + row.failure_count_1h;
  const successRate = total > 0 ? row.success_count_1h / total : 1;
  const avgLatency = row.success_count_1h > 0 ? row.total_latency_ms_1h / row.success_count_1h : 0;

  return {
    agent_type: row.agent_type as AgentHealthStatus['agent_type'],
    model: row.model,
    status: row.status as AgentHealthStatus['status'],
    last_success_at: row.last_success_at,
    last_failure_at: row.last_failure_at,
    success_rate_1h: successRate,
    avg_latency_ms: Math.round(avgLatency),
  };
}

// ── Route registration ────────────────────────────────────────────────────────

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  // GET /v1/health/agents — agent health dashboard
  app.get('/v1/health/agents', async (_req, _reply) => {
    const db = getDb();

    // Reset hourly counters for stale records (>1 hour since last update)
    db.prepare(`
      UPDATE agent_health
      SET success_count_1h = 0, failure_count_1h = 0, total_latency_ms_1h = 0,
          status = CASE WHEN last_success_at > last_failure_at OR last_failure_at IS NULL THEN 'healthy' ELSE 'degraded' END
      WHERE updated_at < datetime('now', '-1 hour')
    `).run();

    const rows = db
      .prepare('SELECT * FROM agent_health ORDER BY agent_type, model')
      .all() as HealthRow[];

    const agents = rows.map(toHealthStatus);

    const summary = {
      total: agents.length,
      healthy: agents.filter((a) => a.status === 'healthy').length,
      degraded: agents.filter((a) => a.status === 'degraded').length,
      unavailable: agents.filter((a) => a.status === 'unavailable').length,
    };

    return { agents, summary, timestamp: new Date().toISOString() };
  });

  // GET /v1/health — overall system health
  app.get('/v1/health/system', async (_req, _reply) => {
    const db = getDb();

    const workflowStats = db
      .prepare(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
          SUM(CASE WHEN status = 'executing' THEN 1 ELSE 0 END) as executing,
          SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled
        FROM workflows
        WHERE created_at > datetime('now', '-1 hour')
      `)
      .get() as {
      total: number;
      completed: number;
      failed: number;
      executing: number;
      cancelled: number;
    };

    const dbSize = db
      .prepare("SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()")
      .get() as { size: number } | undefined;

    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      database: {
        connected: true,
        size_bytes: dbSize?.size ?? 0,
      },
      workflows_1h: workflowStats,
      version: '0.1.0',
    };
  });
}
