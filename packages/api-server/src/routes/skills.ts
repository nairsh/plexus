import { z } from 'zod';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { InvalidRequestError, getErrorMessage, logger } from '@orchestrator/shared';
import { deleteSkillForUser, getAllSkillsForUser, getSkillByIdForUser, upsertSkillForUser } from '@orchestrator/model-router';
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

const SkillImportSchema = z.object({
  skill_id: z.string().trim().min(1),
  markdown: z.string().min(1),
});

function parseImportedSkillMarkdown(markdown: string): {
  description: string;
  prompt_addendum: string;
  tools: Tool['type'][];
} {
  const normalized = markdown.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    throw new InvalidRequestError('Imported skill must include YAML frontmatter', 'markdown');
  }

  const closing = normalized.indexOf('\n---\n', 4);
  if (closing === -1) {
    throw new InvalidRequestError('Imported skill frontmatter is not closed', 'markdown');
  }

  const frontmatter = normalized.slice(4, closing);
  const body = normalized.slice(closing + 5).trim();
  const lines = frontmatter.split('\n');
  const meta = new Map<string, string[]>();
  let currentListKey: string | null = null;

  for (const line of lines) {
    if (!line.trim()) continue;
    const listMatch = line.match(/^\s*-\s*(.+)$/);
    if (listMatch && currentListKey) {
      const existing = meta.get(currentListKey) ?? [];
      existing.push(listMatch[1].trim());
      meta.set(currentListKey, existing);
      continue;
    }

    currentListKey = null;
    const keyValue = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!keyValue) continue;
    const [, key, rawValue] = keyValue;
    if (rawValue === '') {
      currentListKey = key;
      meta.set(key, []);
      continue;
    }
    meta.set(key, [rawValue.trim()]);
  }

  const description = (meta.get('description')?.join('\n') ?? '').trim();
  const tools = (meta.get('tools') ?? meta.get('allowed-tools') ?? [])
    .map((value) => value.trim().toLowerCase())
    .map((value) => value.replace(/^file_read$/, 'file_read'))
    .filter((value): value is Tool['type'] => ToolTypeSchema.safeParse(value).success);

  if (!description) {
    throw new InvalidRequestError('Imported skill must include a description in frontmatter', 'markdown');
  }

  return {
    description,
    prompt_addendum: body,
    tools,
  };
}

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
  fastify.get('/v1/skills', async (request: FastifyRequest) => {
    const skills = getAllSkillsForUser(request.user!.id);
    return { skills: skills.map(toApiSkill) };
  });

  fastify.get('/v1/skills/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const skill = getSkillByIdForUser(request.user!.id, request.params.id);
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

      const existing = getSkillByIdForUser(request.user!.id, request.params.id);
      const body = parseResult.data;

      try {
        const skill = upsertSkillForUser(request.user!.id, request.params.id, {
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

  fastify.post('/v1/skills/import', async (request: FastifyRequest) => {
    const parsed = SkillImportSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      throw new InvalidRequestError(firstError?.message ?? 'Invalid skill import payload', firstError?.path?.join('.'));
    }

    const imported = parseImportedSkillMarkdown(parsed.data.markdown);
    const skill = upsertSkillForUser(request.user!.id, parsed.data.skill_id, {
      name: parsed.data.skill_id,
      description: imported.description,
      prompt_addendum: imported.prompt_addendum,
      tools: imported.tools.map((type) => ({ type })),
    });

    return { skill: toApiSkill(skill) };
  });

  fastify.delete(
    '/v1/skills/:id',
      async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        const deleted = deleteSkillForUser(request.user!.id, request.params.id);
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
