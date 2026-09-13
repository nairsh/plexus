/**
 * Connector tool executors — GitHub, Linear, and Notion API tools
 * that use stored OAuth credentials from the connectors system.
 */
import { getDb, getErrorMessage, logger } from '@orchestrator/shared';
import type { ConnectorProvider } from '@orchestrator/shared';
import { getConnectorCredentials, listConnectorsForUser, validateConnectorForUser } from '../connectors.js';

interface ConnectorCredentials {
  access_token: string;
  refresh_token?: string;
  expires_at?: string;
  token_type?: string;
}

/**
 * Find the first connected connector of a given provider for a user.
 */
const findConnectedConnector = (
  userId: string,
  provider: ConnectorProvider
): { id: string; credentials: ConnectorCredentials } | null => {
  const connectors = listConnectorsForUser(userId);
  const connector = connectors.find((c) => c.provider === provider && c.status === 'connected');
  if (!connector) return null;

  const credentials = getConnectorCredentials(userId, connector.id);
  if (!credentials) return null;

  return { id: connector.id, credentials: credentials as ConnectorCredentials };
};

/**
 * Execute a GitHub REST API call using stored credentials.
 */
export const executeGitHubApi = async (userId: string, args: Record<string, unknown>): Promise<string> => {
  const method = (args.method as string) ?? 'GET';
  const endpoint = args.endpoint as string;
  const body = args.body as Record<string, unknown> | undefined;

  if (!endpoint) {
    return JSON.stringify({ error: 'endpoint is required' });
  }

  const conn = findConnectedConnector(userId, 'github');
  if (!conn) {
    return JSON.stringify({
      error: 'no_github_connector',
      message: 'No connected GitHub account found. Please connect GitHub in the Connectors page first.',
    });
  }

  const url = endpoint.startsWith('https://')
    ? endpoint
    : `https://api.github.com${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;

  try {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${conn.credentials.access_token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    const responseText = await response.text();
    let responseData: unknown;
    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = responseText;
    }

    if (!response.ok) {
      return JSON.stringify({
        error: 'github_api_error',
        status: response.status,
        message: typeof responseData === 'object' ? (responseData as Record<string, unknown>).message : responseText,
      });
    }

    // Truncate large responses
    const result = JSON.stringify(responseData);
    return result.length > 10000 ? result.substring(0, 10000) + '...[truncated]' : result;
  } catch (err) {
    logger.error({ userId, endpoint, error: getErrorMessage(err) }, 'GitHub API call failed');
    return JSON.stringify({ error: 'github_api_error', message: getErrorMessage(err) });
  }
};

/**
 * Execute a Linear GraphQL API call using stored credentials.
 */
export const executeLinearApi = async (userId: string, args: Record<string, unknown>): Promise<string> => {
  const query = args.query as string;
  const variables = args.variables as Record<string, unknown> | undefined;

  if (!query) {
    return JSON.stringify({ error: 'query is required' });
  }

  const conn = findConnectedConnector(userId, 'linear');
  if (!conn) {
    return JSON.stringify({
      error: 'no_linear_connector',
      message: 'No connected Linear account found. Please connect Linear in the Connectors page first.',
    });
  }

  try {
    const response = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${conn.credentials.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });

    const responseData = (await response.json()) as unknown;

    if (!response.ok) {
      return JSON.stringify({
        error: 'linear_api_error',
        status: response.status,
        data: responseData,
      });
    }

    const result = JSON.stringify(responseData);
    return result.length > 10000 ? result.substring(0, 10000) + '...[truncated]' : result;
  } catch (err) {
    logger.error({ userId, error: getErrorMessage(err) }, 'Linear API call failed');
    return JSON.stringify({ error: 'linear_api_error', message: getErrorMessage(err) });
  }
};

/**
 * Execute a Notion API call using stored credentials.
 */
export const executeNotionApi = async (userId: string, args: Record<string, unknown>): Promise<string> => {
  const method = (args.method as string) ?? 'GET';
  const endpoint = args.endpoint as string;
  const body = args.body as Record<string, unknown> | undefined;

  if (!endpoint) {
    return JSON.stringify({ error: 'endpoint is required' });
  }

  const conn = findConnectedConnector(userId, 'notion');
  if (!conn) {
    return JSON.stringify({
      error: 'no_notion_connector',
      message: 'No connected Notion account found. Please connect Notion in the Connectors page first.',
    });
  }

  const url = endpoint.startsWith('https://')
    ? endpoint
    : `https://api.notion.com${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;

  try {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${conn.credentials.access_token}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    const responseData = (await response.json()) as unknown;

    if (!response.ok) {
      return JSON.stringify({
        error: 'notion_api_error',
        status: response.status,
        data: responseData,
      });
    }

    const result = JSON.stringify(responseData);
    return result.length > 10000 ? result.substring(0, 10000) + '...[truncated]' : result;
  } catch (err) {
    logger.error({ userId, endpoint, error: getErrorMessage(err) }, 'Notion API call failed');
    return JSON.stringify({ error: 'notion_api_error', message: getErrorMessage(err) });
  }
};
