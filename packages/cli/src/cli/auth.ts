import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import chalk from 'chalk';

interface OidcMetadata {
  issuer: string;
  token_endpoint: string;
  device_authorization_endpoint?: string;
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

interface TokenResponse {
  access_token: string;
  id_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
}

interface StoredAuth {
  issuer: string;
  client_id: string;
  token_endpoint?: string;
  access_token: string;
  id_token?: string;
  refresh_token?: string;
  token_type: string;
  expires_at: number;
}

const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const DEFAULT_SCOPE = 'openid profile email offline_access';

const getAuthDir = (): string => join(homedir(), '.orchestrator');
const getAuthFile = (): string => join(getAuthDir(), 'auth.json');

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const parseJwtSub = (token: string): string | null => {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const normalized = payload.padEnd(Math.ceil(payload.length / 4) * 4, '=');
    const parsed = JSON.parse(Buffer.from(normalized, 'base64').toString('utf-8')) as Record<string, unknown>;
    return typeof parsed['sub'] === 'string' ? parsed['sub'] : null;
  } catch {
    return null;
  }
};

const loadStoredAuth = (): StoredAuth | null => {
  const authFile = getAuthFile();
  if (!existsSync(authFile)) return null;

  try {
    return JSON.parse(readFileSync(authFile, 'utf-8')) as StoredAuth;
  } catch {
    return null;
  }
};

const saveStoredAuth = (auth: StoredAuth): void => {
  const authDir = getAuthDir();
  mkdirSync(authDir, { recursive: true });
  writeFileSync(getAuthFile(), JSON.stringify(auth, null, 2), 'utf-8');
};

const clearStoredAuth = (): void => {
  if (existsSync(getAuthFile())) {
    rmSync(getAuthFile());
  }
};

const getDeviceConfig = (): {
  issuer: string;
  clientId: string;
  scope: string;
  audience?: string;
  tokenEndpoint?: string;
  deviceAuthorizationEndpoint?: string;
} => {
  const issuer =
    process.env['CLERK_DEVICE_AUTH_ISSUER'] ??
    process.env['CLERK_OIDC_ISSUER'] ??
    process.env['CLERK_AUTH_SERVER_ISSUER'];
  const clientId = process.env['CLERK_DEVICE_AUTH_CLIENT_ID'] ?? process.env['CLERK_OAUTH_CLIENT_ID'];
  const scope = process.env['CLERK_DEVICE_AUTH_SCOPE'] ?? DEFAULT_SCOPE;
  const audience = process.env['CLERK_DEVICE_AUTH_AUDIENCE'] ?? process.env['CLERK_AUDIENCE'];
  const tokenEndpoint = process.env['CLERK_DEVICE_AUTH_TOKEN_ENDPOINT'];
  const deviceAuthorizationEndpoint = process.env['CLERK_DEVICE_AUTH_ENDPOINT'];

  if (!issuer || !clientId) {
    throw new Error(
      'Device auth requires CLERK_DEVICE_AUTH_ISSUER (or CLERK_OIDC_ISSUER) and CLERK_DEVICE_AUTH_CLIENT_ID.'
    );
  }

  return {
    issuer: issuer.replace(/\/$/, ''),
    clientId,
    scope,
    audience,
    tokenEndpoint,
    deviceAuthorizationEndpoint,
  };
};

const discoverOidc = async (issuer: string): Promise<OidcMetadata> => {
  const metadataUrls = [
    `${issuer}/.well-known/oauth-authorization-server`,
    `${issuer}/.well-known/openid-configuration`,
  ];

  for (const metadataUrl of metadataUrls) {
    const response = await fetch(metadataUrl).catch(() => null);
    if (!response?.ok) continue;

    const data = (await response.json()) as Partial<OidcMetadata>;
    if (!data.issuer || !data.token_endpoint) {
      continue;
    }

    return {
      issuer: data.issuer,
      token_endpoint: data.token_endpoint,
      device_authorization_endpoint: data.device_authorization_endpoint,
    };
  }

  throw new Error('OIDC discovery failed for issuer metadata endpoints');
};

const postForm = async (url: string, params: Record<string, string>): Promise<Record<string, unknown>> => {
  const body = new URLSearchParams(params);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  });

  const raw = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const message =
      typeof raw['error_description'] === 'string'
        ? raw['error_description']
        : typeof raw['error'] === 'string'
          ? raw['error']
          : `HTTP ${response.status}`;
    throw new Error(message);
  }

  return raw;
};

const refreshToken = async (auth: StoredAuth): Promise<StoredAuth | null> => {
  if (!auth.refresh_token) return null;

  const metadata = await discoverOidc(auth.issuer);
  const tokenEndpoint = auth.token_endpoint ?? metadata.token_endpoint;
  const tokenPayload = (await postForm(tokenEndpoint, {
    grant_type: 'refresh_token',
    refresh_token: auth.refresh_token,
    client_id: auth.client_id,
  })) as Partial<TokenResponse>;

  if (!tokenPayload.access_token) {
    return null;
  }

  const expiresIn = typeof tokenPayload.expires_in === 'number' ? tokenPayload.expires_in : 3600;
  const next: StoredAuth = {
    issuer: auth.issuer,
    client_id: auth.client_id,
    token_endpoint: tokenEndpoint,
    access_token: tokenPayload.access_token,
    id_token: tokenPayload.id_token ?? auth.id_token,
    refresh_token: tokenPayload.refresh_token ?? auth.refresh_token,
    token_type: tokenPayload.token_type ?? auth.token_type,
    expires_at: Date.now() + expiresIn * 1000,
  };
  saveStoredAuth(next);
  return next;
};

const ensureFreshToken = async (): Promise<StoredAuth | null> => {
  const existing = loadStoredAuth();
  if (!existing) return null;

  const now = Date.now();
  if (existing.expires_at > now + 60_000) {
    return existing;
  }

  try {
    return await refreshToken(existing);
  } catch {
    return null;
  }
};

export async function getCliAccessToken(): Promise<string | null> {
  const auth = await ensureFreshToken();
  return auth?.access_token ?? null;
}

export async function getCliAuthSubject(): Promise<string | null> {
  const auth = await ensureFreshToken();
  if (!auth) return null;

  const idSub = auth.id_token ? parseJwtSub(auth.id_token) : null;
  if (idSub) return idSub;
  return parseJwtSub(auth.access_token);
}

export async function runAuth(action: 'login' | 'logout' | 'status'): Promise<void> {
  if (action === 'logout') {
    clearStoredAuth();
    console.log(chalk.green('Signed out.'));
    return;
  }

  if (action === 'status') {
    const auth = await ensureFreshToken();
    if (!auth) {
      console.log(chalk.yellow('Not signed in.'));
      return;
    }

    const sub = parseJwtSub(auth.id_token ?? auth.access_token) ?? '(unknown subject)';
    console.log(chalk.green('Signed in'));
    console.log(`  Subject: ${sub}`);
    console.log(`  Expires: ${new Date(auth.expires_at).toISOString()}`);
    return;
  }

  const { issuer, clientId, scope, audience, tokenEndpoint, deviceAuthorizationEndpoint } = getDeviceConfig();
  const metadata = await discoverOidc(issuer);
  const resolvedTokenEndpoint = tokenEndpoint ?? metadata.token_endpoint;
  const resolvedDeviceEndpoint = deviceAuthorizationEndpoint ?? metadata.device_authorization_endpoint;

  if (!resolvedDeviceEndpoint) {
    throw new Error(
      'Authorization server does not advertise a device authorization endpoint. Set CLERK_DEVICE_AUTH_ENDPOINT explicitly.'
    );
  }

  const device = (await postForm(resolvedDeviceEndpoint, {
    client_id: clientId,
    scope,
    ...(audience ? { audience } : {}),
  })) as Partial<DeviceCodeResponse>;

  if (!device.device_code || !device.user_code || !device.verification_uri || !device.expires_in) {
    throw new Error('Device authorization response missing required fields');
  }

  console.log(chalk.cyan('\nDevice login started'));
  console.log(`  Code: ${chalk.bold(device.user_code)}`);
  console.log(`  Verify at: ${device.verification_uri}`);
  if (device.verification_uri_complete) {
    console.log(`  Direct link: ${device.verification_uri_complete}`);
  }
  console.log('');

  const intervalMs = Math.max(1000, (device.interval ?? 5) * 1000);
  const deadline = Date.now() + device.expires_in * 1000;
  let currentInterval = intervalMs;

  while (Date.now() < deadline) {
    await sleep(currentInterval);

    const result = await postForm(resolvedTokenEndpoint, {
      grant_type: DEVICE_CODE_GRANT,
      device_code: device.device_code,
      client_id: clientId,
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('authorization_pending')) return { error: 'authorization_pending' };
      if (message.includes('slow_down')) return { error: 'slow_down' };
      if (message.includes('expired_token')) throw new Error('Device code expired before authorization completed');
      throw error;
    });

    if (result['error'] === 'authorization_pending') {
      continue;
    }

    if (result['error'] === 'slow_down') {
      currentInterval += 2000;
      continue;
    }

    const token = result as Partial<TokenResponse>;
    if (!token.access_token) {
      continue;
    }

    const expiresIn = typeof token.expires_in === 'number' ? token.expires_in : 3600;
    saveStoredAuth({
      issuer: metadata.issuer,
      client_id: clientId,
      token_endpoint: resolvedTokenEndpoint,
      access_token: token.access_token,
      id_token: token.id_token,
      refresh_token: token.refresh_token,
      token_type: token.token_type ?? 'Bearer',
      expires_at: Date.now() + expiresIn * 1000,
    });

    const subject = token.id_token ? parseJwtSub(token.id_token) : parseJwtSub(token.access_token);
    console.log(chalk.green('Sign-in complete.'));
    if (subject) {
      console.log(`  Subject: ${subject}`);
    }
    return;
  }

  throw new Error('Device login timed out before authorization completed');
}
