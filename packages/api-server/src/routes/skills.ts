import { z } from 'zod';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { InvalidRequestError, getErrorMessage, logger } from '@orchestrator/shared';
import { deleteSkill, getAllSkills, getSkillById, upsertSkill } from '@orchestrator/model-router';
import type { Skill, Tool } from '@orchestrator/shared';

const ToolTypeSchema = z.enum([
  'web_search',
  'fetch_url',
  'function',
  'code_execution',
  'file_read',
  'file_write',
  'file_edit',
  'bash',
  'grep',
  'glob',
  'run_skill',
  'remember',
  'recall',
]);

const UpsertSkillSchema = z.object({
  name: z.string().trim().min(1).optional(),
  description: z.string().trim().min(1),
  prompt_addendum: z.string(),
  tools: z.array(ToolTypeSchema).optional(),
});

function toApiSkill(skill: Skill): {
  id: string;
  name: string;
  description: string;
  prompt_addendum: string;
  tools: Tool['type'][];
} {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    prompt_addendum: skill.prompt_addendum,
    tools: skill.tools?.map((tool) => tool.type) ?? [],
  };
}

export async function skillsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/v1/skills', async () => {
    const skills = getAllSkills();
    return { skills: skills.map(toApiSkill) };
  });

  fastify.get('/v1/skills/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const skill = getSkillById(request.params.id);
    if (!skill) {
      reply.status(404);
      return {
        error: {
          type: 'invalid_request',
          message: `Skill not found: ${request.params.id}`,
          code: 'skill_not_found',
        },
      };
    }
    return { skill: toApiSkill(skill) };
  });

  fastify.put(
    '/v1/skills/:id',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const parseResult = UpsertSkillSchema.safeParse(request.body);
      if (!parseResult.success) {
        const firstError = parseResult.error.errors[0];
        throw new InvalidRequestError(
          `Validation error: ${firstError?.message ?? 'Invalid request'}`,
          firstError?.path?.join('.') ?? undefined
        );
      }

      const existing = getSkillById(request.params.id);
      const body = parseResult.data;

      try {
        const skill = upsertSkill(request.params.id, {
          name: body.name,
          description: body.description,
          prompt_addendum: body.prompt_addendum,
          tools: body.tools?.map((type) => ({ type })),
        });
        reply.status(existing ? 200 : 201);
        return { skill: toApiSkill(skill) };
      } catch (error) {
        logger.warn({ skillId: request.params.id, error: getErrorMessage(error) }, 'Failed to upsert skill');
        throw new InvalidRequestError(getErrorMessage(error));
      }
    }
  );

  fastify.delete(
    '/v1/skills/:id',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        const deleted = deleteSkill(request.params.id);
        if (!deleted) {
          reply.status(404);
          return {
            deleted: false,
            error: {
              type: 'invalid_request',
              message: `Skill not found: ${request.params.id}`,
              code: 'skill_not_found',
            },
          };
        }
        return { deleted: true, id: request.params.id };
      } catch (error) {
        logger.warn({ skillId: request.params.id, error: getErrorMessage(error) }, 'Failed to delete skill');
        throw new InvalidRequestError(getErrorMessage(error));
      }
    }
  );
}
