import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { InvalidRequestError } from '@orchestrator/shared';
import {
  clearUserRuntimeModelConfig,
  getRuntimeModelConfig,
  saveUserRuntimeModelConfig,
} from '@orchestrator/model-router';

const ModelPreferencesSchema = z.object({
  default_orchestrator_model: z.string().trim().min(1).optional(),
  orchestrator_models: z.array(z.string().trim().min(1)).optional(),
  agent_models: z.record(z.string().trim().min(1)).optional(),
  subagent_models: z.record(z.string().trim().min(1)).optional(),
});

export async function modelPreferencesRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/v1/models/preferences', async (request: FastifyRequest) => {
    const config = getRuntimeModelConfig(request.user!.id);
    return {
      default_orchestrator_model: config.default_orchestrator_model,
      orchestrator_models: config.orchestrator_models,
      agent_models: config.agent_models ?? {},
      subagent_models: config.subagent_models,
      tools: config.tools,
    };
  });

  fastify.put('/v1/models/preferences', async (request: FastifyRequest) => {
    const parsed = ModelPreferencesSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      throw new InvalidRequestError(
        `Validation error: ${firstError?.message ?? 'Invalid request'}`,
        firstError?.path?.join('.') ?? undefined
      );
    }

    saveUserRuntimeModelConfig(request.user!.id, parsed.data);
    const config = getRuntimeModelConfig(request.user!.id);
    return {
      default_orchestrator_model: config.default_orchestrator_model,
      orchestrator_models: config.orchestrator_models,
      agent_models: config.agent_models ?? {},
      subagent_models: config.subagent_models,
      tools: config.tools,
    };
  });

  fastify.delete('/v1/models/preferences', async (request: FastifyRequest) => {
    clearUserRuntimeModelConfig(request.user!.id);
    const config = getRuntimeModelConfig(request.user!.id);
    return {
      default_orchestrator_model: config.default_orchestrator_model,
      orchestrator_models: config.orchestrator_models,
      agent_models: config.agent_models ?? {},
      subagent_models: config.subagent_models,
      tools: config.tools,
    };
  });
}
