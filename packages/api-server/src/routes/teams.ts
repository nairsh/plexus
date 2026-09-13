/**
 * Teams API (beta)
 *
 * Implements shared team management inspired by Claude Code Teams:
 * - Create and manage teams
 * - Add/remove members with role-based access
 * - Share context (instructions, knowledge, templates) across team
 * - Apply team settings to workflows
 *
 * Enable with env: TEAMS_BETA_ENABLED=1
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  getDb,
  getErrorMessage,
  InvalidRequestError,
  logger,
  MAX_TEAM_MEMBERS,
  MAX_TEAM_SHARED_CONTEXTS,
  TEAMS_FEATURE_FLAG,
} from '@orchestrator/shared';
import type { Team, TeamMember, TeamSettings, TeamSharedContext } from '@orchestrator/shared';
import { AgentTypeSchema } from '@orchestrator/shared';

// ── Feature flag guard ────────────────────────────────────────────────────────

function teamsEnabled(): boolean {
  return process.env['TEAMS_BETA_ENABLED'] === '1' || process.env[TEAMS_FEATURE_FLAG] === '1';
}

// ── Schemas ───────────────────────────────────────────────────────────────────

const CreateTeamSchema = z.object({
  name: z.string().min(1).max(100),
  settings: z
    .object({
      shared_model_overrides: z.record(z.string()).optional(),
      shared_tools: z.array(z.string()).optional(),
      shared_instructions: z.string().max(10000).optional(),
      max_credits_per_workflow: z.number().positive().optional(),
      require_approval_for_bash: z.boolean().optional(),
      allowed_agent_types: z.array(AgentTypeSchema).optional(),
      feature_flags: z.record(z.boolean()).optional(),
    })
    .optional(),
});

const UpdateTeamSchema = CreateTeamSchema.partial();

const AddMemberSchema = z.object({
  user_id: z.string(),
  role: z.enum(['admin', 'member']).default('member'),
});

const CreateSharedContextSchema = z.object({
  name: z.string().min(1).max(200),
  content: z.string().max(50000),
  content_type: z.enum(['instructions', 'knowledge', 'template']).default('knowledge'),
});

// ── DB helpers ────────────────────────────────────────────────────────────────

function getTeam(teamId: string): Team | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId) as (Team & { settings: string }) | undefined;
  if (!row) return null;
  return {
    ...row,
    settings: JSON.parse(row.settings) as TeamSettings,
  };
}

function getMember(teamId: string, userId: string): TeamMember | null {
  const db = getDb();
  return (
    (db.prepare('SELECT * FROM team_members WHERE team_id = ? AND user_id = ?').get(teamId, userId) as
      | TeamMember
      | undefined) ?? null
  );
}

function assertMemberWithRole(teamId: string, userId: string, minRole: 'member' | 'admin' | 'owner'): TeamMember {
  const member = getMember(teamId, userId);
  if (!member) throw new InvalidRequestError('Not a member of this team', 'not_team_member');
  const ranks = { member: 0, admin: 1, owner: 2 };
  if (ranks[member.role] < ranks[minRole]) {
    throw new InvalidRequestError(`Requires ${minRole} role`, 'insufficient_role');
  }
  return member;
}

// ── Route registration ────────────────────────────────────────────────────────

export async function registerTeamsRoutes(app: FastifyInstance): Promise<void> {
  // Feature flag guard — only blocks /v1/teams/* routes
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/v1/teams') || teamsEnabled()) return;
    return reply.status(404).send({
      error: {
        type: 'invalid_request',
        message: 'Teams feature is not enabled. Set TEAMS_BETA_ENABLED=1 to enable.',
        code: 'feature_disabled',
      },
    });
  });

  // POST /v1/teams — create team
  app.post('/v1/teams', async (req, reply) => {
    const user = req.user!;
    const body = CreateTeamSchema.safeParse(req.body);
    if (!body.success) {
      throw new InvalidRequestError('Invalid request body', 'validation_error');
    }

    const db = getDb();
    const teamId = crypto.randomUUID();
    const settings = body.data.settings ?? {};

    db.prepare(
      `
      INSERT INTO teams (id, name, owner_id, settings)
      VALUES (?, ?, ?, ?)
    `
    ).run(teamId, body.data.name, user.id, JSON.stringify(settings));

    // Auto-add creator as owner
    db.prepare(
      `
      INSERT INTO team_members (team_id, user_id, role)
      VALUES (?, ?, 'owner')
    `
    ).run(teamId, user.id);

    logger.info({ teamId, userId: user.id }, 'Team created');

    return reply.status(201).send(getTeam(teamId));
  });

  // GET /v1/teams — list user's teams
  app.get('/v1/teams', async (req) => {
    const user = req.user!;
    const db = getDb();

    const rows = db
      .prepare(
        `
        SELECT t.*, tm.role as member_role
        FROM teams t
        JOIN team_members tm ON t.id = tm.team_id
        WHERE tm.user_id = ?
        ORDER BY t.created_at DESC
      `
      )
      .all(user.id) as Array<Team & { settings: string; member_role: string }>;

    return {
      teams: rows.map((r) => ({
        ...r,
        settings: JSON.parse(r.settings) as TeamSettings,
      })),
    };
  });

  // GET /v1/teams/:id — get team details
  app.get('/v1/teams/:id', async (req) => {
    const user = req.user!;
    const { id } = req.params as { id: string };

    assertMemberWithRole(id, user.id, 'member');

    const team = getTeam(id);
    if (!team) throw new InvalidRequestError('Team not found', 'not_found');

    const db = getDb();
    const members = db
      .prepare('SELECT * FROM team_members WHERE team_id = ? ORDER BY joined_at')
      .all(id) as TeamMember[];

    const memberCount = members.length;
    return { ...team, members, member_count: memberCount };
  });

  // PATCH /v1/teams/:id — update team settings
  app.patch('/v1/teams/:id', async (req) => {
    const user = req.user!;
    const { id } = req.params as { id: string };

    assertMemberWithRole(id, user.id, 'admin');

    const body = UpdateTeamSchema.safeParse(req.body);
    if (!body.success) throw new InvalidRequestError('Invalid request body', 'validation_error');

    const db = getDb();
    const team = getTeam(id);
    if (!team) throw new InvalidRequestError('Team not found', 'not_found');

    const updatedSettings = { ...team.settings, ...(body.data.settings ?? {}) };

    db.prepare(
      `
      UPDATE teams SET name = ?, settings = ?, updated_at = datetime('now')
      WHERE id = ?
    `
    ).run(body.data.name ?? team.name, JSON.stringify(updatedSettings), id);

    return getTeam(id);
  });

  // DELETE /v1/teams/:id — delete team (owner only)
  app.delete('/v1/teams/:id', async (req, reply) => {
    const user = req.user!;
    const { id } = req.params as { id: string };

    assertMemberWithRole(id, user.id, 'owner');

    const db = getDb();
    db.prepare('DELETE FROM teams WHERE id = ?').run(id);

    logger.info({ teamId: id, userId: user.id }, 'Team deleted');
    return reply.status(204).send();
  });

  // POST /v1/teams/:id/members — add member
  app.post('/v1/teams/:id/members', async (req) => {
    const user = req.user!;
    const { id } = req.params as { id: string };

    assertMemberWithRole(id, user.id, 'admin');

    const body = AddMemberSchema.safeParse(req.body);
    if (!body.success) throw new InvalidRequestError('Invalid request body', 'validation_error');

    const db = getDb();
    const memberCount = (
      db.prepare('SELECT COUNT(*) as count FROM team_members WHERE team_id = ?').get(id) as {
        count: number;
      }
    ).count;

    if (memberCount >= MAX_TEAM_MEMBERS) {
      throw new InvalidRequestError(`Team has reached the maximum of ${MAX_TEAM_MEMBERS} members`, 'team_full');
    }

    const existing = getMember(id, body.data.user_id);
    if (existing) throw new InvalidRequestError('User is already a member', 'already_member');

    db.prepare(
      `
      INSERT INTO team_members (team_id, user_id, role)
      VALUES (?, ?, ?)
    `
    ).run(id, body.data.user_id, body.data.role);

    return db.prepare('SELECT * FROM team_members WHERE team_id = ? AND user_id = ?').get(id, body.data.user_id);
  });

  // DELETE /v1/teams/:id/members/:userId — remove member
  app.delete('/v1/teams/:id/members/:userId', async (req, reply) => {
    const user = req.user!;
    const { id, userId } = req.params as { id: string; userId: string };

    // Members can remove themselves; admins can remove members
    if (userId !== user.id) {
      assertMemberWithRole(id, user.id, 'admin');
    }

    const member = getMember(id, userId);
    if (!member) throw new InvalidRequestError('Member not found', 'not_found');
    if (member.role === 'owner') throw new InvalidRequestError('Cannot remove team owner', 'cannot_remove_owner');

    const db = getDb();
    db.prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?').run(id, userId);

    return reply.status(204).send();
  });

  // GET /v1/teams/:id/contexts — list shared contexts
  app.get('/v1/teams/:id/contexts', async (req) => {
    const user = req.user!;
    const { id } = req.params as { id: string };

    assertMemberWithRole(id, user.id, 'member');

    const db = getDb();
    const contexts = db
      .prepare('SELECT * FROM team_shared_contexts WHERE team_id = ? ORDER BY created_at DESC')
      .all(id) as TeamSharedContext[];

    return { contexts };
  });

  // POST /v1/teams/:id/contexts — create shared context
  app.post('/v1/teams/:id/contexts', async (req, reply) => {
    const user = req.user!;
    const { id } = req.params as { id: string };

    assertMemberWithRole(id, user.id, 'member');

    const body = CreateSharedContextSchema.safeParse(req.body);
    if (!body.success) throw new InvalidRequestError('Invalid request body', 'validation_error');

    const db = getDb();
    const contextCount = (
      db.prepare('SELECT COUNT(*) as count FROM team_shared_contexts WHERE team_id = ?').get(id) as { count: number }
    ).count;

    if (contextCount >= MAX_TEAM_SHARED_CONTEXTS) {
      throw new InvalidRequestError(
        `Team has reached the maximum of ${MAX_TEAM_SHARED_CONTEXTS} shared contexts`,
        'contexts_limit_reached'
      );
    }

    const contextId = crypto.randomUUID();
    db.prepare(
      `
      INSERT INTO team_shared_contexts (id, team_id, name, content, content_type, created_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `
    ).run(contextId, id, body.data.name, body.data.content, body.data.content_type, user.id);

    const created = db.prepare('SELECT * FROM team_shared_contexts WHERE id = ?').get(contextId) as TeamSharedContext;

    return reply.status(201).send(created);
  });

  // DELETE /v1/teams/:id/contexts/:contextId — delete shared context
  app.delete('/v1/teams/:id/contexts/:contextId', async (req, reply) => {
    const user = req.user!;
    const { id, contextId } = req.params as { id: string; contextId: string };

    assertMemberWithRole(id, user.id, 'member');

    const db = getDb();
    const context = db.prepare('SELECT * FROM team_shared_contexts WHERE id = ? AND team_id = ?').get(contextId, id) as
      | TeamSharedContext
      | undefined;

    if (!context) throw new InvalidRequestError('Context not found', 'not_found');

    // Only creator or admin can delete
    const member = getMember(id, user.id);
    if (context.created_by !== user.id && member?.role === 'member') {
      throw new InvalidRequestError('Cannot delete context created by another member', 'insufficient_role');
    }

    db.prepare('DELETE FROM team_shared_contexts WHERE id = ?').run(contextId);
    return reply.status(204).send();
  });

  // GET /v1/teams/:id/settings — get effective settings for workflow config
  app.get('/v1/teams/:id/settings', async (req) => {
    const user = req.user!;
    const { id } = req.params as { id: string };

    assertMemberWithRole(id, user.id, 'member');

    const team = getTeam(id);
    if (!team) throw new InvalidRequestError('Team not found', 'not_found');

    const db = getDb();
    const contexts = db
      .prepare(
        "SELECT * FROM team_shared_contexts WHERE team_id = ? AND content_type = 'instructions' ORDER BY created_at"
      )
      .all(id) as TeamSharedContext[];

    const combinedInstructions = [team.settings.shared_instructions ?? '', ...contexts.map((c) => c.content)]
      .filter(Boolean)
      .join('\n\n---\n\n');

    return {
      team_id: id,
      settings: team.settings,
      combined_instructions: combinedInstructions,
      model_overrides: team.settings.shared_model_overrides ?? {},
      tools: team.settings.shared_tools ?? [],
      max_credits_per_workflow: team.settings.max_credits_per_workflow,
      require_approval_for_bash: team.settings.require_approval_for_bash ?? false,
    };
  });

  logger.info('Teams routes registered (beta)');
}

// ── Helper: apply team settings to a workflow config ─────────────────────────

export function applyTeamSettingsToConfig(
  teamSettings: TeamSettings,
  config: Record<string, unknown>
): Record<string, unknown> {
  return {
    ...config,
    model_overrides: {
      ...(teamSettings.shared_model_overrides ?? {}),
      ...((config.model_overrides as Record<string, string>) ?? {}), // workflow config takes precedence
    },
    human_approval: teamSettings.require_approval_for_bash === true ? true : config.human_approval,
    max_credits:
      teamSettings.max_credits_per_workflow != null
        ? Math.min(teamSettings.max_credits_per_workflow, (config.max_credits as number) ?? Infinity)
        : config.max_credits,
  };
}

// ── Helper: get team shared instructions for injection into workflow ───────────

export function getTeamSharedInstructions(teamId: string): string {
  try {
    const db = getDb();
    const contexts = db
      .prepare(
        "SELECT content FROM team_shared_contexts WHERE team_id = ? AND content_type IN ('instructions', 'knowledge') ORDER BY created_at"
      )
      .all(teamId) as Array<{ content: string }>;

    return contexts.map((c) => c.content).join('\n\n---\n\n');
  } catch (err) {
    logger.warn({ teamId, error: getErrorMessage(err) }, 'Failed to get team shared instructions');
    return '';
  }
}
