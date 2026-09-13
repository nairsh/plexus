import { randomBytes, createHash } from 'node:crypto';
import { URLSearchParams } from 'node:url';
import {
  decryptJson,
  encryptJson,
  getDb,
  getEnv,
  getErrorMessage,
  InvalidRequestError,
  logger,
} from '@orchestrator/shared';
import type { ConnectorProvider, ConnectorRecord } from '@orchestrator/shared';

interface StoredConnectorRow {
  id: string;
  user_id: string;
  provider: ConnectorProvider;
  status: string;
  display_name: string;
  external_id: string | null;
  scopes: string;
  metadata: string;
  credentials_encrypted: string | null;
  last_validated_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface OAuthStateRow {
  id: string;
  user_id: string;
  provider: ConnectorProvider;
  redirect_uri: string;
  state_token: string;
  code_verifier: string | null;
  requested_scopes: string;
  frontend_origin: string | null;
  expires_at: string;
}

interface ConnectorCredentials {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_at?: string;
  scope?: string;
}

interface OAuthProviderConfig {
  provider: ConnectorProvider;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  getClientId: () => string | undefined;
  getClientSecret: () => string | undefined;
  supportsPkce?: boolean;
  buildAuthorizeParams: (args: {
    clientId: string;
    redirectUri: string;
    state: string;
    scopes: string[];
    codeChallenge?: string;
  }) => URLSearchParams;
  exchangeCode: (args: { code: string; redirectUri: string; codeVerifier?: string }) => Promise<ConnectorCredentials>;
  refreshToken: (args: { refreshToken: string }) => Promise<ConnectorCredentials>;
  fetchAccount: (
    accessToken: string
  ) => Promise<{ displayName: string; externalId: string | null; metadata: Record<string, unknown> }>;
}

const jsonHeaders = {
  Accept: 'application/json',
  'Content-Type': 'application/json',
};

const formHeaders = {
  Accept: 'application/json',
  'Content-Type': 'application/x-www-form-urlencoded',
};

const sha256Base64Url = (value: string): string => {
  return createHash('sha256').update(value).digest('base64url');
};

const generateStateToken = (): string => randomBytes(24).toString('base64url');

const generateCodeVerifier = (): string => randomBytes(48).toString('base64url');

const requireOAuthClient = (provider: ConnectorProvider): { clientId: string; clientSecret: string } => {
  const config = PROVIDERS[provider];
  const clientId = config.getClientId();
  const clientSecret = config.getClientSecret();
  if (!clientId || !clientSecret) {
    throw new InvalidRequestError(`OAuth is not configured for ${provider}`, 'connector_not_configured');
  }
  return { clientId, clientSecret };
};

const parseScopes = (raw: string): string[] => {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    return [];
  }
};

const parseJsonRecord = (raw: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const toConnectorRecord = (row: StoredConnectorRow): ConnectorRecord => ({
  id: row.id,
  user_id: row.user_id,
  provider: row.provider,
  status: row.status as ConnectorRecord['status'],
  display_name: row.display_name,
  scopes: parseScopes(row.scopes),
  external_id: row.external_id,
  metadata: parseJsonRecord(row.metadata),
  last_validated_at: row.last_validated_at,
  last_error: row.last_error,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

const githubHeaders = (token: string) => ({
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${token}`,
  'X-GitHub-Api-Version': '2022-11-28',
});

const PROVIDERS: Record<ConnectorProvider, OAuthProviderConfig> = {
  github: {
    provider: 'github',
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scopes: ['read:user', 'user:email', 'repo', 'read:org'],
    getClientId: () => getEnv().GITHUB_OAUTH_CLIENT_ID,
    getClientSecret: () => getEnv().GITHUB_OAUTH_CLIENT_SECRET,
    buildAuthorizeParams: ({ clientId, redirectUri, state, scopes }) => {
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        state,
        scope: scopes.join(' '),
      });
      return params;
    },
    exchangeCode: async ({ code, redirectUri }) => {
      const { clientId, clientSecret } = requireOAuthClient('github');
      const response = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: formHeaders,
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: redirectUri,
        }),
      });
      const body = (await response.json()) as Record<string, unknown>;
      if (!response.ok || typeof body['access_token'] !== 'string') {
        throw new InvalidRequestError(
          String(body['error_description'] ?? body['error'] ?? 'GitHub token exchange failed')
        );
      }
      const expiresIn = typeof body['expires_in'] === 'number' ? body['expires_in'] : undefined;
      return {
        access_token: body['access_token'],
        refresh_token: typeof body['refresh_token'] === 'string' ? body['refresh_token'] : undefined,
        token_type: typeof body['token_type'] === 'string' ? body['token_type'] : 'bearer',
        scope: typeof body['scope'] === 'string' ? body['scope'] : undefined,
        expires_at: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : undefined,
      };
    },
    refreshToken: async ({ refreshToken }) => {
      const { clientId, clientSecret } = requireOAuthClient('github');
      const response = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: formHeaders,
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }),
      });
      const body = (await response.json()) as Record<string, unknown>;
      if (!response.ok || typeof body['access_token'] !== 'string') {
        throw new InvalidRequestError(String(body['error_description'] ?? body['error'] ?? 'GitHub refresh failed'));
      }
      const expiresIn = typeof body['expires_in'] === 'number' ? body['expires_in'] : undefined;
      return {
        access_token: body['access_token'],
        refresh_token: typeof body['refresh_token'] === 'string' ? body['refresh_token'] : refreshToken,
        token_type: typeof body['token_type'] === 'string' ? body['token_type'] : 'bearer',
        scope: typeof body['scope'] === 'string' ? body['scope'] : undefined,
        expires_at: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : undefined,
      };
    },
    fetchAccount: async (accessToken) => {
      const [userResponse, orgsResponse, reposResponse] = await Promise.all([
        fetch('https://api.github.com/user', { headers: githubHeaders(accessToken) }),
        fetch('https://api.github.com/user/orgs?per_page=100', { headers: githubHeaders(accessToken) }),
        fetch('https://api.github.com/user/repos?per_page=100&sort=updated', { headers: githubHeaders(accessToken) }),
      ]);

      const user = (await userResponse.json()) as Record<string, unknown>;
      if (!userResponse.ok) {
        throw new InvalidRequestError(String(user['message'] ?? 'GitHub account fetch failed'));
      }
      const orgs = orgsResponse.ok ? ((await orgsResponse.json()) as unknown[]) : [];
      const repos = reposResponse.ok ? ((await reposResponse.json()) as unknown[]) : [];
      return {
        displayName: String(user['login'] ?? user['name'] ?? 'GitHub'),
        externalId: typeof user['id'] === 'number' ? String(user['id']) : null,
        metadata: {
          login: user['login'],
          avatar_url: user['avatar_url'],
          html_url: user['html_url'],
          organizations: Array.isArray(orgs)
            ? orgs.slice(0, 25).map((entry) => {
                const record = entry as Record<string, unknown>;
                return { id: record['id'], login: record['login'], avatar_url: record['avatar_url'] };
              })
            : [],
          repositories: Array.isArray(repos)
            ? repos.slice(0, 50).map((entry) => {
                const record = entry as Record<string, unknown>;
                return {
                  id: record['id'],
                  name: record['name'],
                  full_name: record['full_name'],
                  private: record['private'],
                  updated_at: record['updated_at'],
                };
              })
            : [],
        },
      };
    },
  },
  linear: {
    provider: 'linear',
    authorizeUrl: 'https://linear.app/oauth/authorize',
    tokenUrl: 'https://api.linear.app/oauth/token',
    scopes: ['read', 'write'],
    getClientId: () => getEnv().LINEAR_OAUTH_CLIENT_ID,
    getClientSecret: () => getEnv().LINEAR_OAUTH_CLIENT_SECRET,
    supportsPkce: true,
    buildAuthorizeParams: ({ clientId, redirectUri, state, scopes, codeChallenge }) => {
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: scopes.join(','),
        state,
      });
      if (codeChallenge) {
        params.set('code_challenge', codeChallenge);
        params.set('code_challenge_method', 'S256');
      }
      return params;
    },
    exchangeCode: async ({ code, redirectUri, codeVerifier }) => {
      const { clientId, clientSecret } = requireOAuthClient('linear');
      const body = new URLSearchParams({
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
      });
      if (codeVerifier) body.set('code_verifier', codeVerifier);
      const response = await fetch('https://api.linear.app/oauth/token', {
        method: 'POST',
        headers: formHeaders,
        body,
      });
      const json = (await response.json()) as Record<string, unknown>;
      if (!response.ok || typeof json['access_token'] !== 'string') {
        throw new InvalidRequestError(
          String(json['error_description'] ?? json['error'] ?? 'Linear token exchange failed')
        );
      }
      return {
        access_token: json['access_token'],
        refresh_token: typeof json['refresh_token'] === 'string' ? json['refresh_token'] : undefined,
        token_type: typeof json['token_type'] === 'string' ? json['token_type'] : 'Bearer',
        scope: typeof json['scope'] === 'string' ? json['scope'] : undefined,
        expires_at:
          typeof json['expires_in'] === 'number'
            ? new Date(Date.now() + json['expires_in'] * 1000).toISOString()
            : undefined,
      };
    },
    refreshToken: async ({ refreshToken }) => {
      const { clientId, clientSecret } = requireOAuthClient('linear');
      const response = await fetch('https://api.linear.app/oauth/token', {
        method: 'POST',
        headers: {
          ...formHeaders,
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        },
        body: new URLSearchParams({ refresh_token: refreshToken, grant_type: 'refresh_token' }),
      });
      const json = (await response.json()) as Record<string, unknown>;
      if (!response.ok || typeof json['access_token'] !== 'string') {
        throw new InvalidRequestError(String(json['error_description'] ?? json['error'] ?? 'Linear refresh failed'));
      }
      return {
        access_token: json['access_token'],
        refresh_token: typeof json['refresh_token'] === 'string' ? json['refresh_token'] : refreshToken,
        token_type: typeof json['token_type'] === 'string' ? json['token_type'] : 'Bearer',
        scope: typeof json['scope'] === 'string' ? json['scope'] : undefined,
        expires_at:
          typeof json['expires_in'] === 'number'
            ? new Date(Date.now() + json['expires_in'] * 1000).toISOString()
            : undefined,
      };
    },
    fetchAccount: async (accessToken) => {
      const response = await fetch('https://api.linear.app/graphql', {
        method: 'POST',
        headers: {
          ...jsonHeaders,
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          query: 'query ConnectorViewer { viewer { id name email } teams { nodes { id name key } } }',
        }),
      });
      const json = (await response.json()) as Record<string, unknown>;
      if (!response.ok || json['errors']) {
        throw new InvalidRequestError('Linear account fetch failed');
      }
      const data = (json['data'] as Record<string, unknown>) ?? {};
      const viewer = (data['viewer'] as Record<string, unknown>) ?? {};
      const teams = (((data['teams'] as Record<string, unknown>)?.['nodes'] as unknown[]) ?? []).map((entry) => {
        const record = entry as Record<string, unknown>;
        return { id: record['id'], name: record['name'], key: record['key'] };
      });
      return {
        displayName: String(viewer['name'] ?? viewer['email'] ?? 'Linear'),
        externalId: typeof viewer['id'] === 'string' ? viewer['id'] : null,
        metadata: {
          viewer,
          teams,
        },
      };
    },
  },
  notion: {
    provider: 'notion',
    authorizeUrl: 'https://api.notion.com/v1/oauth/authorize',
    tokenUrl: 'https://api.notion.com/v1/oauth/token',
    scopes: [],
    getClientId: () => getEnv().NOTION_OAUTH_CLIENT_ID,
    getClientSecret: () => getEnv().NOTION_OAUTH_CLIENT_SECRET,
    buildAuthorizeParams: ({ clientId, redirectUri, state }) => {
      return new URLSearchParams({
        owner: 'user',
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        state,
      });
    },
    exchangeCode: async ({ code, redirectUri }) => {
      const { clientId, clientSecret } = requireOAuthClient('notion');
      const response = await fetch('https://api.notion.com/v1/oauth/token', {
        method: 'POST',
        headers: {
          ...jsonHeaders,
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
        }),
      });
      const json = (await response.json()) as Record<string, unknown>;
      if (!response.ok || typeof json['access_token'] !== 'string') {
        throw new InvalidRequestError(
          String(json['error_description'] ?? json['error'] ?? 'Notion token exchange failed')
        );
      }
      return {
        access_token: json['access_token'],
        refresh_token: typeof json['refresh_token'] === 'string' ? json['refresh_token'] : undefined,
        token_type: typeof json['token_type'] === 'string' ? json['token_type'] : 'bearer',
      };
    },
    refreshToken: async ({ refreshToken }) => {
      const { clientId, clientSecret } = requireOAuthClient('notion');
      const response = await fetch('https://api.notion.com/v1/oauth/token', {
        method: 'POST',
        headers: {
          ...jsonHeaders,
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }),
      });
      const json = (await response.json()) as Record<string, unknown>;
      if (!response.ok || typeof json['access_token'] !== 'string') {
        throw new InvalidRequestError(String(json['error_description'] ?? json['error'] ?? 'Notion refresh failed'));
      }
      return {
        access_token: json['access_token'],
        refresh_token: typeof json['refresh_token'] === 'string' ? json['refresh_token'] : refreshToken,
        token_type: typeof json['token_type'] === 'string' ? json['token_type'] : 'bearer',
      };
    },
    fetchAccount: async (accessToken) => {
      const notionVersion = getEnv().NOTION_API_VERSION;
      const response = await fetch('https://api.notion.com/v1/users/me', {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${accessToken}`,
          'Notion-Version': notionVersion,
        },
      });
      const json = (await response.json()) as Record<string, unknown>;
      if (!response.ok) {
        throw new InvalidRequestError(String((json as { message?: string }).message ?? 'Notion account fetch failed'));
      }
      const bot = (json['bot'] as Record<string, unknown> | undefined) ?? {};
      return {
        displayName: String(json['name'] ?? bot['workspace_name'] ?? 'Notion'),
        externalId: typeof json['id'] === 'string' ? json['id'] : null,
        metadata: {
          workspace_name: bot['workspace_name'],
          workspace_icon: bot['workspace_icon'],
          owner: bot['owner'],
        },
      };
    },
  },
};

export const listConnectorProviders = (): Array<{
  provider: ConnectorProvider;
  scopes: string[];
  configured: boolean;
}> => {
  return (Object.keys(PROVIDERS) as ConnectorProvider[]).map((provider) => {
    const config = PROVIDERS[provider];
    return {
      provider,
      scopes: [...config.scopes],
      configured: Boolean(config.getClientId() && config.getClientSecret()),
    };
  });
};

export const listConnectorsForUser = (userId: string): ConnectorRecord[] => {
  const rows = getDb()
    .prepare('SELECT * FROM connectors WHERE user_id = ? ORDER BY updated_at DESC')
    .all(userId) as StoredConnectorRow[];
  return rows.map(toConnectorRecord);
};

export const getConnectorForUser = (userId: string, connectorId: string): ConnectorRecord | null => {
  const row = getDb().prepare('SELECT * FROM connectors WHERE user_id = ? AND id = ?').get(userId, connectorId) as
    | StoredConnectorRow
    | undefined;
  return row ? toConnectorRecord(row) : null;
};

export const getConnectorCredentials = (userId: string, connectorId: string): ConnectorCredentials | null => {
  const row = getDb()
    .prepare('SELECT credentials_encrypted FROM connectors WHERE user_id = ? AND id = ?')
    .get(userId, connectorId) as { credentials_encrypted: string | null } | undefined;
  if (!row?.credentials_encrypted) return null;
  return decryptJson<ConnectorCredentials>(row.credentials_encrypted);
};

const persistConnector = (args: {
  connectorId: string;
  userId: string;
  provider: ConnectorProvider;
  displayName: string;
  externalId: string | null;
  scopes: string[];
  metadata: Record<string, unknown>;
  credentials: ConnectorCredentials;
  status: 'connected' | 'error';
  lastError?: string | null;
}): ConnectorRecord => {
  const db = getDb();
  db.prepare(
    `INSERT INTO connectors (
      id, user_id, provider, status, display_name, external_id, scopes, metadata,
      credentials_encrypted, last_validated_at, last_error, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      display_name = excluded.display_name,
      external_id = excluded.external_id,
      scopes = excluded.scopes,
      metadata = excluded.metadata,
      credentials_encrypted = excluded.credentials_encrypted,
      last_validated_at = excluded.last_validated_at,
      last_error = excluded.last_error,
      updated_at = datetime('now')`
  ).run(
    args.connectorId,
    args.userId,
    args.provider,
    args.status,
    args.displayName,
    args.externalId,
    JSON.stringify(args.scopes),
    JSON.stringify(args.metadata),
    encryptJson(args.credentials),
    args.lastError ?? null
  );
  const saved = getConnectorForUser(args.userId, args.connectorId);
  if (!saved) {
    throw new InvalidRequestError('Connector persistence failed');
  }
  return saved;
};

export const beginConnectorOAuth = (args: {
  userId: string;
  provider: ConnectorProvider;
  redirectUri?: string;
  frontendOrigin?: string;
  scopes?: string[];
}): { state: string; authorize_url: string; expires_at: string; redirect_uri: string } => {
  const config = PROVIDERS[args.provider];
  const { clientId } = requireOAuthClient(args.provider);
  const redirectUri =
    args.redirectUri?.trim() ||
    `${getEnv().PUBLIC_BASE_URL.replace(/\/$/, '')}/v1/connectors/${args.provider}/callback`;
  const state = generateStateToken();
  const codeVerifier = config.supportsPkce ? generateCodeVerifier() : null;
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  const scopes = (args.scopes && args.scopes.length > 0 ? args.scopes : config.scopes).filter(Boolean);

  getDb()
    .prepare(
      `INSERT INTO connector_oauth_states (
        id, user_id, provider, redirect_uri, state_token, code_verifier, requested_scopes, frontend_origin, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      crypto.randomUUID(),
      args.userId,
      args.provider,
      redirectUri,
      state,
      codeVerifier,
      JSON.stringify(scopes),
      args.frontendOrigin ?? null,
      expiresAt
    );

  const authorizeParams = config.buildAuthorizeParams({
    clientId,
    redirectUri,
    state,
    scopes,
    codeChallenge: codeVerifier ? sha256Base64Url(codeVerifier) : undefined,
  });

  return {
    state,
    authorize_url: `${config.authorizeUrl}?${authorizeParams.toString()}`,
    expires_at: expiresAt,
    redirect_uri: redirectUri,
  };
};

const consumeOAuthState = (provider: ConnectorProvider, stateToken: string): OAuthStateRow => {
  const row = getDb()
    .prepare('SELECT * FROM connector_oauth_states WHERE provider = ? AND state_token = ?')
    .get(provider, stateToken) as OAuthStateRow | undefined;
  if (!row) {
    throw new InvalidRequestError('OAuth state not found or expired', 'invalid_state');
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    getDb().prepare('DELETE FROM connector_oauth_states WHERE id = ?').run(row.id);
    throw new InvalidRequestError('OAuth state expired', 'invalid_state');
  }
  getDb().prepare('DELETE FROM connector_oauth_states WHERE id = ?').run(row.id);
  return row;
};

export const completeConnectorOAuth = async (args: {
  provider: ConnectorProvider;
  state: string;
  code: string;
}): Promise<{ connector: ConnectorRecord; frontend_origin: string | null }> => {
  const providerConfig = PROVIDERS[args.provider];
  const oauthState = consumeOAuthState(args.provider, args.state);
  const token = await providerConfig.exchangeCode({
    code: args.code,
    redirectUri: oauthState.redirect_uri,
    codeVerifier: oauthState.code_verifier ?? undefined,
  });
  const account = await providerConfig.fetchAccount(token.access_token);
  const connector = persistConnector({
    connectorId: crypto.randomUUID(),
    userId: oauthState.user_id,
    provider: args.provider,
    displayName: account.displayName,
    externalId: account.externalId,
    scopes: parseScopes(oauthState.requested_scopes),
    metadata: account.metadata,
    credentials: token,
    status: 'connected',
  });
  return { connector, frontend_origin: oauthState.frontend_origin };
};

export const validateConnectorForUser = async (userId: string, connectorId: string): Promise<ConnectorRecord> => {
  const connector = getConnectorForUser(userId, connectorId);
  if (!connector) {
    throw new InvalidRequestError('Connector not found', 'not_found');
  }

  let credentials = getConnectorCredentials(userId, connectorId);
  if (!credentials?.access_token) {
    throw new InvalidRequestError('Connector has no credentials', 'connector_invalid');
  }

  const provider = PROVIDERS[connector.provider];
  if (
    credentials.expires_at &&
    new Date(credentials.expires_at).getTime() < Date.now() + 60_000 &&
    credentials.refresh_token
  ) {
    credentials = await provider.refreshToken({ refreshToken: credentials.refresh_token });
  }

  try {
    const account = await provider.fetchAccount(credentials.access_token);
    return persistConnector({
      connectorId: connector.id,
      userId,
      provider: connector.provider,
      displayName: account.displayName,
      externalId: account.externalId,
      scopes: connector.scopes,
      metadata: account.metadata,
      credentials,
      status: 'connected',
      lastError: null,
    });
  } catch (error) {
    logger.warn({ connectorId, error: getErrorMessage(error) }, 'Connector validation failed');
    const db = getDb();
    db.prepare(
      `UPDATE connectors SET status = 'error', last_error = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?`
    ).run(getErrorMessage(error), connectorId, userId);
    const failed = getConnectorForUser(userId, connectorId);
    if (!failed) {
      throw new InvalidRequestError('Connector not found', 'not_found');
    }
    return failed;
  }
};

export const disconnectConnectorForUser = (userId: string, connectorId: string): void => {
  const result = getDb()
    .prepare(
      `UPDATE connectors
       SET status = 'disconnected', credentials_encrypted = NULL, updated_at = datetime('now')
       WHERE id = ? AND user_id = ?`
    )
    .run(connectorId, userId);
  if (result.changes === 0) {
    throw new InvalidRequestError('Connector not found', 'not_found');
  }
};
