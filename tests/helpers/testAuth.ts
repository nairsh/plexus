type PrepareAuthOptions = {
  baseUrl: string;
  probePath?: string;
  testLabel: string;
};

const DEFAULT_PROBE_PATH = '/v1/billing/balance';

export async function prepareTestAuth(options: PrepareAuthOptions): Promise<string> {
  const baseUrl = options.baseUrl;
  const probePath = options.probePath ?? DEFAULT_PROBE_PATH;

  const explicitBearer = process.env['TEST_AUTH_BEARER_TOKEN'] ?? process.env['TEST_CLERK_BEARER_TOKEN'];
  if (explicitBearer) {
    await assertAuthTokenWorks(baseUrl, explicitBearer, probePath, 'Provided TEST_AUTH_BEARER_TOKEN is invalid');
    return explicitBearer;
  }

  // Check if server is running in DISABLE_AUTH mode (returns 200 with no token)
  if (await canAuthenticate(baseUrl, '', probePath)) {
    return '';
  }

  throw new Error(
    `Auth bootstrap failed for ${options.testLabel}. ` +
      'Set TEST_AUTH_BEARER_TOKEN to a valid Clerk session/JWT for integration tests, ' +
      'or start the server with DISABLE_AUTH=true for local dev.'
  );
}

export function authHeaders(token: string, extra?: Record<string, string>): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    ...extra,
  };
}

async function assertAuthTokenWorks(
  baseUrl: string,
  token: string,
  probePath: string,
  message: string
): Promise<void> {
  const ok = await canAuthenticate(baseUrl, token, probePath);
  if (!ok) {
    throw new Error(message);
  }
}

async function canAuthenticate(baseUrl: string, token: string, probePath: string): Promise<boolean> {
  const res = await fetch(`${baseUrl}${probePath}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.status !== 401;
}
