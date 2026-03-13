import { createHash } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { getDb, AuthenticationError, logger } from '@orchestrator/shared';
import type { AuthUser } from '@orchestrator/shared';

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

export async function authMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    const err = new AuthenticationError('Missing or invalid Authorization header. Expected: Bearer <api_key>');
    reply.status(err.statusCode).send(err.toJSON());
    return;
  }

  const apiKey = authHeader.substring(7);
  if (!apiKey) {
    const err = new AuthenticationError('Empty API key');
    reply.status(err.statusCode).send(err.toJSON());
    return;
  }

  const keyHash = createHash('sha256').update(apiKey).digest('hex');

  const db = getDb();

  const row = db
    .prepare(
      `SELECT ak.id as key_id, ak.user_id, ak.permissions, ak.revoked_at,
              u.id, u.email, u.tier, u.credits_balance
       FROM api_keys ak
       JOIN users u ON ak.user_id = u.id
       WHERE ak.key_hash = ?`
    )
    .get(keyHash) as
    | {
        key_id: string;
        user_id: string;
        permissions: string;
        revoked_at: string | null;
        id: string;
        email: string | null;
        tier: string;
        credits_balance: number;
      }
    | undefined;

  if (!row) {
    const err = new AuthenticationError('Invalid API key');
    reply.status(err.statusCode).send(err.toJSON());
    return;
  }

  if (row.revoked_at) {
    const err = new AuthenticationError('API key has been revoked');
    reply.status(err.statusCode).send(err.toJSON());
    return;
  }

  // Update last_used_at
  db.prepare('UPDATE api_keys SET last_used_at = datetime(\'now\') WHERE id = ?').run(
    row.key_id
  );

  request.user = {
    id: row.user_id,
    email: row.email,
    tier: row.tier as AuthUser['tier'],
    credits_balance: row.credits_balance,
  };
}
