/**
 * Workflow Templates API
 *
 * Allows users to save, share, and reuse workflow configurations.
 * Templates capture objective patterns and configuration without the objective itself.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb, InvalidRequestError, logger } from '@orchestrator/shared';
import type { WorkflowTemplate } from '@orchestrator/shared';

// ── Schemas ───────────────────────────────────────────────────────────────────

const CreateTemplateSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().min(1).max(2000),
  config: z.object({
    orchestrator_model: z.string().optional(),
    model_overrides: z.record(z.string()).optional(),
    tools: z.array(z.string()).optional(),
    max_credits: z.number().positive().optional(),
    human_approval: z.boolean().optional(),
  }),
  is_public: z.boolean().default(false),
  tags: z.array(z.string().max(50)).max(20).default([]),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseTemplate(row: WorkflowTemplate & { config: string; tags: string }): WorkflowTemplate {
  return {
    ...row,
    config: JSON.parse(row.config) as WorkflowTemplate['config'],
    tags: JSON.parse(row.tags) as string[],
  };
}

// ── Route registration ────────────────────────────────────────────────────────

export async function registerTemplatesRoutes(app: FastifyInstance): Promise<void> {
  // GET /v1/templates — list public + user's own templates
  app.get('/v1/templates', async (req) => {
    const user = req.user!;
    const { tag, search } = req.query as { tag?: string; search?: string };
    const db = getDb();

    let query = `
      SELECT * FROM workflow_templates
      WHERE (is_public = 1 OR created_by = ?)
    `;
    const params: unknown[] = [user.id];

    if (tag) {
      query += ` AND tags LIKE ?`;
      params.push(`%${tag}%`);
    }
    if (search) {
      query += ` AND (name LIKE ? OR description LIKE ?)`;
      params.push(`%${search}%`, `%${search}%`);
    }

    query += ' ORDER BY usage_count DESC, created_at DESC LIMIT 100';

    const rows = db.prepare(query).all(...params) as Array<WorkflowTemplate & { config: string; tags: string }>;

    return { templates: rows.map(parseTemplate) };
  });

  // POST /v1/templates — create template
  app.post('/v1/templates', async (req, reply) => {
    const user = req.user!;
    const body = CreateTemplateSchema.safeParse(req.body);
    if (!body.success) throw new InvalidRequestError('Invalid request body', 'validation_error');

    const db = getDb();
    const id = crypto.randomUUID();

    db.prepare(
      `
      INSERT INTO workflow_templates (id, name, description, config, created_by, is_public, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `
    ).run(
      id,
      body.data.name,
      body.data.description,
      JSON.stringify(body.data.config),
      user.id,
      body.data.is_public ? 1 : 0,
      JSON.stringify(body.data.tags)
    );

    const created = db.prepare('SELECT * FROM workflow_templates WHERE id = ?').get(id) as WorkflowTemplate & {
      config: string;
      tags: string;
    };

    logger.info({ templateId: id, userId: user.id }, 'Workflow template created');
    return reply.status(201).send(parseTemplate(created));
  });

  // GET /v1/templates/:id — get template
  app.get('/v1/templates/:id', async (req) => {
    const { id } = req.params as { id: string };
    const user = req.user!;
    const db = getDb();

    const row = db
      .prepare('SELECT * FROM workflow_templates WHERE id = ? AND (is_public = 1 OR created_by = ?)')
      .get(id, user.id) as (WorkflowTemplate & { config: string; tags: string }) | undefined;

    if (!row) throw new InvalidRequestError('Template not found', 'not_found');
    return parseTemplate(row);
  });

  // POST /v1/templates/:id/use — use a template (returns workflow config)
  app.post('/v1/templates/:id/use', async (req) => {
    const { id } = req.params as { id: string };
    const user = req.user!;
    const { objective } = req.body as { objective?: string };

    const db = getDb();
    const row = db
      .prepare('SELECT * FROM workflow_templates WHERE id = ? AND (is_public = 1 OR created_by = ?)')
      .get(id, user.id) as (WorkflowTemplate & { config: string; tags: string }) | undefined;

    if (!row) throw new InvalidRequestError('Template not found', 'not_found');

    // Increment usage count
    db.prepare(
      "UPDATE workflow_templates SET usage_count = usage_count + 1, updated_at = datetime('now') WHERE id = ?"
    ).run(id);

    const template = parseTemplate(row);
    return {
      template_id: id,
      config: {
        ...template.config,
        objective: objective ?? `Task based on template: ${template.name}`,
      },
    };
  });

  // DELETE /v1/templates/:id — delete template (owner only)
  app.delete('/v1/templates/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const user = req.user!;
    const db = getDb();

    const row = db.prepare('SELECT * FROM workflow_templates WHERE id = ? AND created_by = ?').get(id, user.id);

    if (!row) throw new InvalidRequestError('Template not found or not authorized', 'not_found');

    db.prepare('DELETE FROM workflow_templates WHERE id = ?').run(id);
    return reply.status(204).send();
  });
}
