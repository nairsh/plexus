import { describe, expect, test, vi, beforeEach } from 'vitest';

// Mock getEnv before importing creditCheckMiddleware
vi.mock('@orchestrator/shared', async () => {
  const actual = await vi.importActual<typeof import('@orchestrator/shared')>('@orchestrator/shared');
  return {
    ...actual,
    getEnv: vi.fn(),
  };
});

import { creditCheckMiddleware } from '../packages/api-server/src/middleware/creditCheck.js';
import { getEnv } from '@orchestrator/shared';

const mockGetEnv = getEnv as ReturnType<typeof vi.fn>;

function createMockReply() {
  const reply = {
    statusCode: 200,
    _body: null as unknown,
    status(code: number) {
      reply.statusCode = code;
      return reply;
    },
    send(body: unknown) {
      reply._body = body;
      return reply;
    },
  };
  return reply;
}

describe('creditCheckMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('skips when BILLING_MODE is not enforced', async () => {
    mockGetEnv.mockReturnValue({ BILLING_MODE: 'disabled' });
    const request = { user: { credits_balance: 0, tier: 'free' } } as any;
    const reply = createMockReply();

    await creditCheckMiddleware(request, reply as any);
    // Should NOT send an error
    expect(reply._body).toBeNull();
  });

  test('skips when no user on request', async () => {
    mockGetEnv.mockReturnValue({ BILLING_MODE: 'enforced' });
    const request = {} as any;
    const reply = createMockReply();

    await creditCheckMiddleware(request, reply as any);
    expect(reply._body).toBeNull();
  });

  test('skips for enterprise tier users', async () => {
    mockGetEnv.mockReturnValue({ BILLING_MODE: 'enforced' });
    const request = { user: { credits_balance: 0, tier: 'enterprise' } } as any;
    const reply = createMockReply();

    await creditCheckMiddleware(request, reply as any);
    expect(reply._body).toBeNull();
  });

  test('sends 402 when credits_balance is 0', async () => {
    mockGetEnv.mockReturnValue({ BILLING_MODE: 'enforced' });
    const request = { user: { credits_balance: 0, tier: 'free' } } as any;
    const reply = createMockReply();

    await creditCheckMiddleware(request, reply as any);
    expect(reply.statusCode).toBe(402);
    expect(reply._body).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'insufficient_credits' }),
      })
    );
  });

  test('sends 402 when credits_balance is negative', async () => {
    mockGetEnv.mockReturnValue({ BILLING_MODE: 'enforced' });
    const request = { user: { credits_balance: -5, tier: 'pro' } } as any;
    const reply = createMockReply();

    await creditCheckMiddleware(request, reply as any);
    expect(reply.statusCode).toBe(402);
  });

  test('allows when credits_balance is positive', async () => {
    mockGetEnv.mockReturnValue({ BILLING_MODE: 'enforced' });
    const request = { user: { credits_balance: 10, tier: 'free' } } as any;
    const reply = createMockReply();

    await creditCheckMiddleware(request, reply as any);
    expect(reply._body).toBeNull();
    expect(reply.statusCode).toBe(200);
  });
});
