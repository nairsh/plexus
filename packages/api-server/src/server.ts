import Fastify from 'fastify';
import cors from '@fastify/cors';
import { logger, runMigrations, closeDb, AppError, InternalError, getEnv } from '@orchestrator/shared';
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
import { registerTemplatesRoutes } from './routes/templates.js';
import { registerHealthRoutes } from './routes/agentHealth.js';

export async function createServer() {
  const fastify = Fastify({
    logger: false, // We use our own pino logger
    bodyLimit: 10 * 1024 * 1024, // 10MB
  });

  // CORS
  await fastify.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  // Health check (no auth)
  fastify.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '0.1.0',
  }));

  // Models list (no auth required)
  fastify.get('/v1/models', async () => ({
    models: getAllModels(),
    orchestrator_models: getAllowedOrchestratorModels(),
    default_orchestrator_model: getDefaultOrchestratorModel(),
    subagent_models: getRuntimeModelConfig().subagent_models,
  }));

  // Presets list (no auth required)
  fastify.get('/v1/presets', async () => ({ presets: getAllPresets() }));

  // Auth middleware for all /v1/ routes (except models/presets/health)
  fastify.addHook('onRequest', async (request, reply) => {
    const url = request.url;

    // Skip auth for health, models list, and presets list
    if (
      url === '/health' ||
      url === '/v1/models' ||
      url === '/v1/presets'
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
      }
    }
  });

  // Global error handler — must be registered BEFORE routes (register calls)
  // so that plugin-scoped errors propagate here correctly in Fastify v5.
  fastify.setErrorHandler(
    (
      error: Error & { validation?: unknown; statusCode?: number; type?: string; code?: string },
      _request,
      reply
    ) => {
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
  await registerTemplatesRoutes(fastify);
  await registerHealthRoutes(fastify);

  return fastify;
}

export async function startServer() {
  // Run migrations
  logger.info('Running database migrations...');
  runMigrations();

  // Seed model registry
  logger.info('Seeding model registry...');
  seedModelRegistry();

  // Create and start server
  const server = await createServer();
  const port = getEnv().PORT;

  // Start background services
  const cleanerInterval = startRateLimitCleaner();
  const reaperInterval = startSessionReaper();
  const meterInterval = startCreditMeter();

  logger.info('Background services started (rate limit cleaner, session reaper, credit meter)');

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down...');
    clearInterval(cleanerInterval);
    clearInterval(reaperInterval);
    clearInterval(meterInterval);
    await server.close();
    closeDb();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await server.listen({ port, host: '0.0.0.0' });
  logger.info({ port }, `Server started on port ${port}`);

  return server;
}
