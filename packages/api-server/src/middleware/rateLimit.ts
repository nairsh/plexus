import type { FastifyRequest, FastifyReply } from 'fastify';
import { RateLimitError } from '@orchestrator/shared';

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

const buckets = new Map<string, TokenBucket>();

const TIER_LIMITS: Record<string, number> = {
  free: 20,
  pro: 100,
  max: 500,
  enterprise: 1000,
};

const REFILL_INTERVAL_MS = 60_000; // 1 minute

export async function rateLimitMiddleware(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const user = request.user;
  if (!user) return; // Auth middleware should have run first

  const limit = TIER_LIMITS[user.tier] ?? 20;
  const now = Date.now();
  const key = user.id;

  let bucket = buckets.get(key);

  if (!bucket) {
    bucket = { tokens: limit, lastRefill: now };
    buckets.set(key, bucket);
  }

  // Refill tokens
  const elapsed = now - bucket.lastRefill;
  if (elapsed >= REFILL_INTERVAL_MS) {
    const refills = Math.floor(elapsed / REFILL_INTERVAL_MS);
    bucket.tokens = Math.min(limit, bucket.tokens + refills * limit);
    bucket.lastRefill = now;
  }

  if (bucket.tokens <= 0) {
    const retryAfter = Math.ceil((REFILL_INTERVAL_MS - (now - bucket.lastRefill)) / 1000);
    const err = new RateLimitError(retryAfter);
    reply.status(429).header('Retry-After', String(retryAfter)).send(err.toJSON());
    return;
  }

  bucket.tokens--;
}

/**
 * Periodically clean up old buckets to prevent memory leaks.
 */
export function startRateLimitCleaner(intervalMs = 300_000): NodeJS.Timeout {
  return setInterval(() => {
    const now = Date.now();
    const staleThreshold = 10 * 60_000; // 10 minutes
    for (const [key, bucket] of buckets) {
      if (now - bucket.lastRefill > staleThreshold) {
        buckets.delete(key);
      }
    }
  }, intervalMs);
}
