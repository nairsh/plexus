import type { FastifyRequest, FastifyReply } from 'fastify';
import { createClerkClient } from '@clerk/backend';
import { getDb, getEnv, AuthenticationError, InternalError, logger } from '@orchestrator/shared';
import type { AuthUser } from '@orchestrator/shared';

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

export async function authMiddleware(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const env = getEnv();

  if (env.DISABLE_AUTH) {
    request.user = getOrCreateDevUser();
    return;
  }

  if (!env.CLERK_SECRET_KEY && !env.CLERK_JWT_KEY) {
    const err = new InternalError('Server auth is misconfigured: set CLERK_SECRET_KEY or CLERK_JWT_KEY');
    reply.status(err.statusCode).send(err.toJSON());
    return;
  }

  const clerkUser = await authenticateWithClerk(request);
  if (!clerkUser) {
    const err = new AuthenticationError('Invalid or expired Clerk token');
    reply.status(err.statusCode).send(err.toJSON());
    return;
  }

  request.user = clerkUser;
}

async function authenticateWithClerk(request: FastifyRequest): Promise<AuthUser | null> {
  const env = getEnv();
  try {
    const audience = splitCsv(env.CLERK_AUDIENCE);
    const authorizedParties = resolveAuthorizedParties(request, env.CLERK_AUTHORIZED_PARTIES);

    const clerkClient = createClerkClient({
      ...(env.CLERK_SECRET_KEY ? { secretKey: env.CLERK_SECRET_KEY } : {}),
      ...(env.CLERK_PUBLISHABLE_KEY ? { publishableKey: env.CLERK_PUBLISHABLE_KEY } : {}),
      ...(env.CLERK_JWT_KEY ? { jwtKey: env.CLERK_JWT_KEY } : {}),
    });

    const authState = await clerkClient.authenticateRequest(toWebRequest(request), {
      acceptsToken: 'session_token',
      ...(audience.length > 0 ? { audience } : {}),
      ...(authorizedParties.length > 0 ? { authorizedParties } : {}),
      clockSkewInMs: env.CLERK_CLOCK_SKEW_MS,
    });

    if (!authState.isAuthenticated) {
      logger.warn(
        {
          reason: authState.reason,
          message: authState.message,
          path: request.url,
          origin: request.headers.origin,
        },
        'Clerk authentication failed'
      );
      return null;
    }

    const auth = authState.toAuth() as { userId?: string | null; sessionClaims?: Record<string, unknown> | null };
    const clerkUserId = typeof auth.userId === 'string' ? auth.userId : null;
    if (!clerkUserId) {
      return null;
    }

    const email = extractEmail(auth.sessionClaims ?? {});
    return upsertClerkUser(clerkUserId, email);
  } catch (error) {
    logger.debug({ error: error instanceof Error ? error.message : String(error) }, 'Clerk token verification failed');
    return null;
  }
}

function toWebRequest(request: FastifyRequest): Request {
  const proto = (request.headers['x-forwarded-proto'] as string | undefined) ?? request.protocol ?? 'http';
  const host = request.headers.host ?? 'localhost:8080';
  const url = `${proto}://${host}${request.url}`;

  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const entry of value) {
        headers.append(key, entry);
      }
      continue;
    }
    headers.set(key, String(value));
  }

  return new Request(url, { method: request.method, headers });
}

function splitCsv(input?: string): string[] {
  if (!input) return [];
  return input
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function resolveAuthorizedParties(request: FastifyRequest, configured?: string): string[] {
  const explicit = splitCsv(configured);
  if (explicit.length > 0) {
    return explicit;
  }

  const origin = request.headers.origin;
  if (typeof origin === 'string' && origin.trim().length > 0) {
    return [origin.trim()];
  }

  return [];
}

function extractEmail(claims: Record<string, unknown>): string | null {
  if (typeof claims['email'] === 'string') return claims['email'];
  if (typeof claims['email_address'] === 'string') return claims['email_address'];
  return null;
}

function getOrCreateDevUser(): AuthUser {
  const db = getDb();
  const devUserId = 'dev-user-local';
  db.prepare(
    "INSERT OR IGNORE INTO users (id, email, tier, credits_balance, created_at) VALUES (?, 'dev@localhost', 'pro', 1000, datetime('now'))"
  ).run(devUserId);
  const row = db.prepare('SELECT id, email, tier, credits_balance FROM users WHERE id = ?').get(devUserId) as
    | { id: string; email: string | null; tier: AuthUser['tier']; credits_balance: number }
    | undefined;
  if (!row) throw new Error('Failed to create dev user');
  return { id: row.id, email: row.email, tier: row.tier, credits_balance: row.credits_balance };
}

function upsertClerkUser(clerkUserId: string, email: string | null): AuthUser {
  const db = getDb();

  db.prepare(
    "INSERT OR IGNORE INTO users (id, tier, credits_balance, created_at) VALUES (?, 'free', 0, datetime('now'))"
  ).run(clerkUserId);

  if (email) {
    try {
      db.prepare("UPDATE users SET email = ? WHERE id = ? AND (email IS NULL OR email = '')").run(email, clerkUserId);
    } catch {
      // Ignore email uniqueness collisions during migration.
    }
  }

  const row = db.prepare('SELECT id, email, tier, credits_balance FROM users WHERE id = ?').get(clerkUserId) as
    | { id: string; email: string | null; tier: AuthUser['tier']; credits_balance: number }
    | undefined;

  if (!row) {
    throw new Error(`failed_to_upsert_user:${clerkUserId}`);
  }

  return {
    id: row.id,
    email: row.email,
    tier: row.tier,
    credits_balance: row.credits_balance,
  };
}
