import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';

// Mock the shared module to avoid DB initialization
vi.mock('@orchestrator/shared', async () => {
  const actual = await vi.importActual<typeof import('@orchestrator/shared')>('@orchestrator/shared');
  return {
    ...actual,
    RateLimitError: actual.RateLimitError,
  };
});

import { rateLimitMiddleware, startRateLimitCleaner } from '../packages/api-server/src/middleware/rateLimit.js';

function createMockRequest(userId: string, tier = 'free') {
  return {
    user: { id: userId, tier, credits_balance: 100, email: 'test@test.com' },
  } as any;
}

function createMockReply() {
  const reply = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    _body: null as unknown,
    status(code: number) {
      reply.statusCode = code;
      return reply;
    },
    header(key: string, value: string) {
      reply.headers[key] = value;
      return reply;
    },
    send(body: unknown) {
      reply._body = body;
      return reply;
    },
  };
  return reply;
}

describe('rateLimitMiddleware', () => {
  const origEnv = process.env['NODE_ENV'];

  beforeEach(() => {
    // Ensure rate limiting is active
    delete process.env['NODE_ENV'];
    delete process.env['SKIP_RATE_LIMIT'];
  });

  afterEach(() => {
    if (origEnv) process.env['NODE_ENV'] = origEnv;
  });

  test('skips when no user on request', async () => {
    const request = {} as any;
    const reply = createMockReply();
    await rateLimitMiddleware(request, reply as any);
    expect(reply._body).toBeNull();
  });

  test('skips when NODE_ENV is test', async () => {
    process.env['NODE_ENV'] = 'test';
    const request = createMockRequest('user-skip-test');
    const reply = createMockReply();
    await rateLimitMiddleware(request, reply as any);
    expect(reply._body).toBeNull();
  });

  test('skips when SKIP_RATE_LIMIT is set', async () => {
    process.env['SKIP_RATE_LIMIT'] = '1';
    const request = createMockRequest('user-skip-flag');
    const reply = createMockReply();
    await rateLimitMiddleware(request, reply as any);
    expect(reply._body).toBeNull();
  });

  test('allows requests within rate limit', async () => {
    // Use unique user ID to avoid bucket contamination from other tests
    const request = createMockRequest('user-within-limit-' + Date.now());
    const reply = createMockReply();
    await rateLimitMiddleware(request, reply as any);
    expect(reply.statusCode).toBe(200);
    expect(reply._body).toBeNull();
  });

  test('returns 429 when tokens exhausted', async () => {
    const userId = 'user-exhausted-' + Date.now();
    // Use a tier with low limit to exhaust quickly; unknown tier defaults to 20
    for (let i = 0; i < 21; i++) {
      const request = createMockRequest(userId, 'unknown_tier');
      const reply = createMockReply();
      await rateLimitMiddleware(request, reply as any);
    }
    // 21st request (after 20 tokens exhausted) should be rate limited
    const request = createMockRequest(userId, 'unknown_tier');
    const reply = createMockReply();
    await rateLimitMiddleware(request, reply as any);
    expect(reply.statusCode).toBe(429);
    expect(reply.headers['Retry-After']).toBeDefined();
    const retryAfter = parseInt(reply.headers['Retry-After']!);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });

  test('Retry-After is never 0', async () => {
    const userId = 'user-retry-after-' + Date.now();
    // Exhaust tokens
    for (let i = 0; i < 21; i++) {
      const request = createMockRequest(userId, 'unknown_tier');
      const reply = createMockReply();
      await rateLimitMiddleware(request, reply as any);
    }
    const request = createMockRequest(userId, 'unknown_tier');
    const reply = createMockReply();
    await rateLimitMiddleware(request, reply as any);
    const retryAfter = parseInt(reply.headers['Retry-After']!);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
  });
});

describe('startRateLimitCleaner', () => {
  test('returns an interval handle', () => {
    const handle = startRateLimitCleaner(60_000);
    expect(handle).toBeDefined();
    clearInterval(handle);
  });
});
