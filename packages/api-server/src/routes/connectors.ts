import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  beginConnectorOAuth,
  completeConnectorOAuth,
  disconnectConnectorForUser,
  getConnectorForUser,
  getConnectorCredentials,
  listConnectorsForUser,
  listConnectorProviders,
  validateConnectorForUser,
} from '@orchestrator/model-router';
import { InvalidRequestError } from '@orchestrator/shared';
import type { ConnectorProvider, ToolApprovalDecision } from '@orchestrator/shared';
import { resolveWorkflowApproval } from '@orchestrator/orchestrator';

const ConnectorProviderSchema = z.enum(['github', 'linear', 'notion']);

const StartConnectorSchema = z.object({
  redirect_uri: z.string().url().optional(),
  frontend_origin: z.string().url().optional(),
  scopes: z.array(z.string().min(1)).optional(),
});

const ApprovalDecisionSchema = z.object({
  decision: z.enum(['approve', 'approve_command_session', 'approve_all_session', 'deny']),
});

const getCallbackSuccessHtml = (args: {
  provider: ConnectorProvider;
  frontendOrigin: string | null;
  connectorId: string;
  displayName: string;
}) => {
  const payload = JSON.stringify({
    type: 'connector:oauth-complete',
    provider: args.provider,
    connectorId: args.connectorId,
    displayName: args.displayName,
  });
  const targetOrigin = JSON.stringify(args.frontendOrigin ?? '*');
  return `<!doctype html>
<html>
  <body style="font-family: sans-serif; padding: 24px; background: #faf7f1; color: #111;">
    <h2>Connection complete</h2>
    <p>${args.displayName} is now connected. You can close this window.</p>
    <script>
      const payload = ${payload};
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage(payload, ${targetOrigin});
      }
      setTimeout(() => window.close(), 300);
    </script>
  </body>
</html>`;
};

const escapeHtml = (str: string): string =>
  str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const getCallbackErrorHtml = (message: string) => `<!doctype html>
<html>
  <body style="font-family: sans-serif; padding: 24px; background: #fff4f3; color: #7f1d1d;">
    <h2>Connection failed</h2>
    <p>${escapeHtml(message)}</p>
  </body>
</html>`;

export async function connectorsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/v1/connectors/providers', async () => {
    return { providers: listConnectorProviders() };
  });

  fastify.get('/v1/connectors', async (request: FastifyRequest) => {
    return { connectors: listConnectorsForUser(request.user!.id) };
  });

  fastify.get('/v1/connectors/:id', async (request: FastifyRequest<{ Params: { id: string } }>) => {
    const connector = getConnectorForUser(request.user!.id, request.params.id);
    if (!connector) {
      throw new InvalidRequestError('Connector not found', 'not_found');
    }
    return { connector };
  });

  fastify.post('/v1/connectors/:provider/start', async (request: FastifyRequest<{ Params: { provider: ConnectorProvider } }>) => {
    const provider = ConnectorProviderSchema.parse(request.params.provider);
    const parsed = StartConnectorSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new InvalidRequestError('Invalid connector start request', 'validation_error');
    }

    return beginConnectorOAuth({
      userId: request.user!.id,
      provider,
      redirectUri: parsed.data.redirect_uri,
      frontendOrigin: parsed.data.frontend_origin,
      scopes: parsed.data.scopes,
    });
  });

  fastify.get(
    '/v1/connectors/:provider/callback',
    async (request: FastifyRequest<{ Params: { provider: ConnectorProvider }; Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>, reply: FastifyReply) => {
      const provider = ConnectorProviderSchema.parse(request.params.provider);
      if (request.query.error) {
        return reply.type('text/html').send(getCallbackErrorHtml(request.query.error_description ?? request.query.error));
      }
      if (!request.query.code || !request.query.state) {
        return reply.type('text/html').send(getCallbackErrorHtml('Missing authorization code or state.'));
      }

      try {
        const { connector, frontend_origin } = await completeConnectorOAuth({
          provider,
          state: request.query.state,
          code: request.query.code,
        });
        return reply.type('text/html').send(
          getCallbackSuccessHtml({
            provider,
            frontendOrigin: frontend_origin,
            connectorId: connector.id,
            displayName: connector.display_name,
          })
        );
      } catch (error) {
        return reply.type('text/html').send(getCallbackErrorHtml(error instanceof Error ? error.message : String(error)));
      }
    }
  );

  fastify.post('/v1/connectors/:id/validate', async (request: FastifyRequest<{ Params: { id: string } }>) => {
    const connector = await validateConnectorForUser(request.user!.id, request.params.id);
    return { connector };
  });

  fastify.delete('/v1/connectors/:id', async (request: FastifyRequest<{ Params: { id: string } }>) => {
    disconnectConnectorForUser(request.user!.id, request.params.id);
    return { disconnected: true, id: request.params.id };
  });

  // Proxy endpoint for making authenticated API calls via connectors
  const ProxyRequestSchema = z.object({
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
    endpoint: z.string(),
    body: z.any().optional(),
    headers: z.record(z.string()).optional(),
  });

  fastify.post(
    '/v1/connectors/:id/proxy',
    async (request: FastifyRequest<{ Params: { id: string } }>) => {
      const parsed = ProxyRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new InvalidRequestError('Invalid proxy request', 'validation_error');
      }

      const connector = getConnectorForUser(request.user!.id, request.params.id);
      if (!connector) {
        throw new InvalidRequestError('Connector not found', 'not_found');
      }

      const credentials = getConnectorCredentials(request.user!.id, request.params.id);
      if (!credentials) {
        throw new InvalidRequestError('Could not decrypt credentials', 'credentials_error');
      }

      const { method, endpoint, body, headers: extraHeaders } = parsed.data;

      let baseUrl: string;
      const reqHeaders: Record<string, string> = {
        Authorization: `Bearer ${credentials.access_token}`,
        ...extraHeaders,
      };

      switch (connector.provider) {
        case 'github':
          baseUrl = 'https://api.github.com';
          reqHeaders['Accept'] = 'application/vnd.github+json';
          reqHeaders['X-GitHub-Api-Version'] = '2022-11-28';
          break;
        case 'linear':
          baseUrl = 'https://api.linear.app';
          reqHeaders['Content-Type'] = 'application/json';
          break;
        case 'notion':
          baseUrl = 'https://api.notion.com';
          reqHeaders['Notion-Version'] = '2022-06-28';
          reqHeaders['Content-Type'] = 'application/json';
          break;
        default:
          throw new InvalidRequestError(`Unknown provider: ${connector.provider}`, 'validation_error');
      }

      const url = `${baseUrl}${endpoint.startsWith('/') ? endpoint : '/' + endpoint}`;
      const response = await fetch(url, {
        method,
        headers: reqHeaders,
        body: body ? JSON.stringify(body) : undefined,
      });

      const responseData = await response.json().catch(() => response.text());
      return {
        status: response.status,
        data: responseData,
      };
    }
  );

  fastify.post(
    '/v1/workflows/:id/bash-approvals/:approvalId',
    async (request: FastifyRequest<{ Params: { id: string; approvalId: string } }>) => {
      const parsed = ApprovalDecisionSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new InvalidRequestError('Invalid approval decision', 'validation_error');
      }
      resolveWorkflowApproval(request.params.id, request.params.approvalId, parsed.data.decision as ToolApprovalDecision);
      return { resolved: true, approval_id: request.params.approvalId };
    }
  );
}
