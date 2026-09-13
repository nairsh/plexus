import Fastify from 'fastify';
import cors from '@fastify/cors';

declare module 'fastify' {
  interface FastifyRequest {
    requestId: string;
  }
}

import { logger, runMigrations, closeDb, AppError, InternalError, getEnv, getDb } from '@orchestrator/shared';
import {
  seedModelRegistry,
  getAllModels,
  getAllowedOrchestratorModels,
  getDefaultOrchestratorModel,
  getRuntimeModelConfig,
  getAllPresets,
} from '@orchestrator/model-router';
import { startSessionReaper, startCreditMeter } from '@orchestrator/sandbox';
import { authMiddleware } from './middleware/auth.js';
import { rateLimitMiddleware, startRateLimitCleaner } from './middleware/rateLimit.js';
import { creditCheckMiddleware } from './middleware/creditCheck.js';
import { responsesRoutes } from './routes/responses.js';
import { billingRoutes } from './routes/billing.js';
import { sandboxRoutes } from './routes/sandbox.js';
import { workflowRoutes } from './routes/workflows.js';
import { registerTeamsRoutes } from './routes/teams.js';
import { registerHealthRoutes } from './routes/agentHealth.js';
import { schedulesRoutes } from './routes/schedules.js';
import { memoryRoutes } from './routes/memory.js';
import { skillsRoutes } from './routes/skills.js';
import { modelPreferencesRoutes } from './routes/modelPreferences.js';
import { providersRoutes } from './routes/providers.js';
import { connectorsRoutes } from './routes/connectors.js';
import { knowledgeRoutes } from './routes/knowledge.js';
import { filesRoutes } from './routes/files.js';
import { registerTemplatesRoutes } from './routes/templates.js';
import { startScheduler, stopScheduler, abortAllWorkflows } from '@orchestrator/orchestrator';

export async function createServer() {
  const fastify = Fastify({
    logger: false, // We use our own pino logger
    bodyLimit: 10 * 1024 * 1024, // 10MB
  });

  // CORS
  await fastify.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Cache-Control'],
  });

  // Health check (no auth) — both /health and /v1/health are supported
  const healthHandler = async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '0.1.0',
  });
  fastify.get('/health', healthHandler);
  fastify.get('/v1/health', healthHandler);

  // Models list (no auth required)
  fastify.get('/v1/models', async () => ({
    models: getAllModels(),
    orchestrator_models: getAllowedOrchestratorModels(),
    default_orchestrator_model: getDefaultOrchestratorModel(),
    subagent_models: getRuntimeModelConfig().subagent_models,
  }));

  // Presets list (no auth required)
  fastify.get('/v1/presets', async () => ({ presets: getAllPresets() }));

  // Decorate requests with a requestId for tracing
  fastify.decorateRequest('requestId', '');

  // Assign X-Request-ID for tracing across the request lifecycle
  fastify.addHook('onRequest', async (request, reply) => {
    const requestId = (request.headers['x-request-id'] as string) ?? crypto.randomUUID();
    reply.header('X-Request-ID', requestId);
    request.requestId = requestId;
  });

  // Auth middleware for all /v1/ routes (except models/presets/health)
  fastify.addHook('onRequest', async (request, reply) => {
    const url = request.url;

    // Skip auth for public health/discovery and OAuth callbacks.
    if (
      url === '/health' ||
      url === '/v1/models' ||
      url === '/v1/presets' ||
      /^\/v1\/connectors\/(github|linear|notion)\/callback(?:\?.*)?$/.test(url)
    ) {
      return;
    }

    // Only require auth for /v1/ paths
    if (url.startsWith('/v1/')) {
      await authMiddleware(request, reply);
      if (reply.sent) return;

      await rateLimitMiddleware(request, reply);
      if (reply.sent) return;

      // Credit check for mutating endpoints (skip billing routes)
      if (request.method === 'POST' && !url.includes('/billing/')) {
        await creditCheckMiddleware(request, reply);
        if (reply.sent) return;
      }
    }
  });

  // Global error handler — must be registered BEFORE routes (register calls)
  // so that plugin-scoped errors propagate here correctly in Fastify v5.
  fastify.setErrorHandler(
    (error: Error & { validation?: unknown; statusCode?: number; type?: string; code?: string }, _request, reply) => {
      if (error instanceof AppError) {
        reply.status(error.statusCode).send(error.toJSON());
        return;
      }

      // Duck-type check: errors with our API error shape (type + code + statusCode)
      // Handles cases where instanceof fails across module boundaries
      if (error.type && error.code && typeof error.statusCode === 'number') {
        reply.status(error.statusCode).send({
          error: {
            type: error.type,
            message: error.message,
            code: error.code,
          },
        });
        return;
      }

      // Zod validation errors
      if (error.name === 'ZodError') {
        reply.status(400).send({
          error: {
            type: 'invalid_request',
            message: error.message,
            code: 'validation_error',
          },
        });
        return;
      }

      // Fastify JSON schema validation errors
      if (error.validation) {
        reply.status(400).send({
          error: {
            type: 'invalid_request',
            message: error.message,
            code: 'validation_error',
          },
        });
        return;
      }

      // Fastify framework errors (body too large = 413, etc.) that have a statusCode < 500
      if (typeof error.statusCode === 'number' && error.statusCode < 500) {
        reply.status(error.statusCode).send({
          error: {
            type: 'request_error',
            message: error.message,
            code: error.code ?? 'request_error',
          },
        });
        return;
      }

      logger.error({ error: error.message, stack: error.stack }, 'Unhandled error');

      const internalErr = new InternalError();
      reply.status(500).send(internalErr.toJSON());
    }
  );

  // Register routes
  await fastify.register(responsesRoutes);
  await fastify.register(billingRoutes);
  await fastify.register(sandboxRoutes);
  await fastify.register(workflowRoutes);

  // Beta features
  await registerTeamsRoutes(fastify);
  await registerHealthRoutes(fastify);
  await fastify.register(schedulesRoutes);
  await fastify.register(memoryRoutes);
  await fastify.register(skillsRoutes);
  await fastify.register(modelPreferencesRoutes);
  await fastify.register(providersRoutes);
  await fastify.register(connectorsRoutes);
  await fastify.register(knowledgeRoutes);
  await fastify.register(filesRoutes);
  await registerTemplatesRoutes(fastify);

  return fastify;
}

export async function startServer() {
  // Validate environment variables eagerly — fail fast on bad config
  const env = getEnv();
  logger.info({ port: env.PORT, nodeEnv: env.NODE_ENV, billingMode: env.BILLING_MODE }, 'Environment validated');

  // Run migrations
  logger.info('Running database migrations...');
  runMigrations();

  // Clean up workflows that were executing when the server last shut down / crashed
  try {
    const db = getDb();
    const stale = db
      .prepare(
        `
      UPDATE workflows
      SET status = 'failed', error = 'Server restarted while workflow was executing', updated_at = datetime('now')
      WHERE status = 'executing'
    `
      )
      .run().changes;
    if (stale > 0) {
      logger.info(
        { clearedCount: stale },
        'Marked stale executing workflows as failed on startup (use /retry to re-run)'
      );
    }

    // Clean up expired OAuth states
    const expiredOAuth = db
      .prepare(
        `
      DELETE FROM connector_oauth_states WHERE expires_at < datetime('now')
    `
      )
      .run().changes;
    if (expiredOAuth > 0) {
      logger.info({ clearedCount: expiredOAuth }, 'Cleaned up expired OAuth states on startup');
    }
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      'Failed to clean stale data on startup (non-critical)'
    );
  }

  // Seed model registry
  logger.info('Seeding model registry...');
  await seedModelRegistry();

  // Create and start server
  const server = await createServer();
  const port = getEnv().PORT;

  // Start background services
  const cleanerInterval = startRateLimitCleaner();
  const reaperInterval = startSessionReaper();
  const meterInterval = startCreditMeter();

  // Periodic OAuth state cleanup (every 30 minutes)
  const oauthCleanerInterval = setInterval(
    () => {
      try {
        const cleaned = getDb()
          .prepare(`DELETE FROM connector_oauth_states WHERE expires_at < datetime('now')`)
          .run().changes;
        if (cleaned > 0) {
          logger.debug({ clearedCount: cleaned }, 'Cleaned expired OAuth states');
        }
      } catch (err) {
        logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'OAuth cleanup failed');
      }
    },
    30 * 60 * 1000
  );

  startScheduler();
  logger.info('Background services started (rate limit cleaner, session reaper, credit meter, workflow scheduler)');

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down gracefully...');

    // 1. Stop accepting new work
    clearInterval(cleanerInterval);
    clearInterval(reaperInterval);
    clearInterval(meterInterval);
    clearInterval(oauthCleanerInterval);
    stopScheduler();

    // 2. Abort in-flight workflows so they can exit cleanly
    const aborted = abortAllWorkflows();
    if (aborted > 0) {
      logger.info({ count: aborted }, 'Aborted in-flight workflows');
      // Brief grace period to let abort handlers run
      await new Promise((r) => setTimeout(r, 2000));
    }

    // 3. Close HTTP server (drains in-flight requests)
    await server.close();

    // 4. Close database
    closeDb();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await server.listen({ port, host: '0.0.0.0' });
  logger.info({ port }, `Server started on port ${port}`);

  return server;
}
