import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getDb, InvalidRequestError } from '@orchestrator/shared';
import crypto from 'node:crypto';

// ── Provider Presets ──────────────────────────────────────────────────────
export const PROVIDER_PRESETS: Record<string, { displayName: string; apiUrl: string; urlEditable: boolean }> = {
  openai:     { displayName: 'OpenAI',     apiUrl: 'https://api.openai.com/v1',                          urlEditable: false },
  deepseek:   { displayName: 'Deepseek',   apiUrl: 'https://api.deepseek.com/v1',                       urlEditable: false },
  google:     { displayName: 'Google AI',   apiUrl: 'https://generativelanguage.googleapis.com/v1beta',  urlEditable: false },
  openrouter: { displayName: 'OpenRouter',  apiUrl: 'https://openrouter.ai/api/v1',                     urlEditable: false },
  litellm:    { displayName: 'LiteLLM',     apiUrl: '',                                                  urlEditable: true  },
  custom:     { displayName: 'Custom',      apiUrl: '',                                                  urlEditable: true  },
};

const ProviderTypeEnum = z.enum(['openai', 'deepseek', 'google', 'openrouter', 'litellm', 'custom']);

const CreateProviderSchema = z.object({
  provider_type: ProviderTypeEnum,
  display_name: z.string().trim().min(1).max(120),
  api_url: z.string().trim().url().max(500),
  api_key: z.string().trim().min(1).max(500),
  embedding_model: z.string().trim().max(200).optional(),
  is_default_embedding: z.boolean().optional(),
});

const UpdateProviderSchema = z.object({
  display_name: z.string().trim().min(1).max(120).optional(),
  api_url: z.string().trim().url().max(500).optional(),
  api_key: z.string().trim().min(1).max(500).optional(),
  embedding_model: z.string().trim().max(200).optional(),
  is_default_embedding: z.boolean().optional(),
  is_active: z.boolean().optional(),
});

// Simple obfuscation – in prod you'd use a proper KMS / envelope encryption.
// This prevents plain-text keys sitting in the DB file.
function obfuscateKey(plain: string): string {
  return Buffer.from(plain).toString('base64');
}
function deobfuscateKey(encoded: string): string {
  return Buffer.from(encoded, 'base64').toString('utf-8');
}
function maskKey(plain: string): string {
  if (plain.length <= 8) return '••••••••';
  return plain.slice(0, 4) + '••••' + plain.slice(-4);
}

interface ProviderRow {
  id: string;
  user_id: string;
  provider_type: string;
  display_name: string;
  api_url: string;
  api_key_encrypted: string;
  embedding_model: string | null;
  is_default_embedding: number;
  is_active: number;
  created_at: string;
  updated_at: string;
}

function rowToResponse(row: ProviderRow) {
  const rawKey = row.api_key_encrypted ? deobfuscateKey(row.api_key_encrypted) : '';
  return {
    id: row.id,
    provider_type: row.provider_type,
    display_name: row.display_name,
    api_url: row.api_url,
    api_key_masked: maskKey(rawKey),
    embedding_model: row.embedding_model ?? null,
    is_default_embedding: row.is_default_embedding === 1,
    is_active: row.is_active === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function providersRoutes(fastify: FastifyInstance): Promise<void> {
  // ── List providers ────────────────────────────────────────────────────
  fastify.get('/v1/providers', async (request: FastifyRequest) => {
    const userId = request.user!.id;
    const rows = getDb()
      .prepare('SELECT * FROM user_api_providers WHERE user_id = ? ORDER BY created_at ASC')
      .all(userId) as ProviderRow[];
    return { providers: rows.map(rowToResponse) };
  });

  // ── List presets (static) ─────────────────────────────────────────────
  fastify.get('/v1/providers/presets', async () => {
    return { presets: PROVIDER_PRESETS };
  });

  // ── Create provider ───────────────────────────────────────────────────
  fastify.post('/v1/providers', async (request: FastifyRequest) => {
    const parsed = CreateProviderSchema.safeParse(request.body);
    if (!parsed.success) {
      const e = parsed.error.errors[0];
      throw new InvalidRequestError(e?.message ?? 'Invalid request', e?.path?.join('.'));
    }
    const { provider_type, display_name, api_url, api_key, embedding_model, is_default_embedding } = parsed.data;
    const userId = request.user!.id;
    const id = crypto.randomUUID();

    // If setting as default embedding, clear other defaults first
    if (is_default_embedding) {
      getDb()
        .prepare('UPDATE user_api_providers SET is_default_embedding = 0 WHERE user_id = ?')
        .run(userId);
    }

    getDb()
      .prepare(`INSERT INTO user_api_providers
        (id, user_id, provider_type, display_name, api_url, api_key_encrypted, embedding_model, is_default_embedding)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, userId, provider_type, display_name, api_url, obfuscateKey(api_key), embedding_model ?? null, is_default_embedding ? 1 : 0);

    const row = getDb()
      .prepare('SELECT * FROM user_api_providers WHERE id = ?')
      .get(id) as ProviderRow;
    return rowToResponse(row);
  });

  // ── Update provider ───────────────────────────────────────────────────
  fastify.put(
    '/v1/providers/:id',
    async (request: FastifyRequest<{ Params: { id: string } }>) => {
      const parsed = UpdateProviderSchema.safeParse(request.body);
      if (!parsed.success) {
        const e = parsed.error.errors[0];
        throw new InvalidRequestError(e?.message ?? 'Invalid request', e?.path?.join('.'));
      }
      const userId = request.user!.id;
      const providerId = (request.params as { id: string }).id;

      const existing = getDb()
        .prepare('SELECT * FROM user_api_providers WHERE id = ? AND user_id = ?')
        .get(providerId, userId) as ProviderRow | undefined;
      if (!existing) throw new InvalidRequestError('Provider not found');

      const updates = parsed.data;
      if (updates.display_name !== undefined) {
        getDb().prepare('UPDATE user_api_providers SET display_name = ?, updated_at = datetime(\'now\') WHERE id = ?').run(updates.display_name, providerId);
      }
      if (updates.api_url !== undefined) {
        getDb().prepare('UPDATE user_api_providers SET api_url = ?, updated_at = datetime(\'now\') WHERE id = ?').run(updates.api_url, providerId);
      }
      if (updates.api_key !== undefined) {
        getDb().prepare('UPDATE user_api_providers SET api_key_encrypted = ?, updated_at = datetime(\'now\') WHERE id = ?').run(obfuscateKey(updates.api_key), providerId);
      }
      if (updates.embedding_model !== undefined) {
        getDb().prepare('UPDATE user_api_providers SET embedding_model = ?, updated_at = datetime(\'now\') WHERE id = ?').run(updates.embedding_model, providerId);
      }
      if (updates.is_default_embedding !== undefined) {
        if (updates.is_default_embedding) {
          getDb().prepare('UPDATE user_api_providers SET is_default_embedding = 0 WHERE user_id = ?').run(userId);
        }
        getDb().prepare('UPDATE user_api_providers SET is_default_embedding = ?, updated_at = datetime(\'now\') WHERE id = ?').run(updates.is_default_embedding ? 1 : 0, providerId);
      }
      if (updates.is_active !== undefined) {
        getDb().prepare('UPDATE user_api_providers SET is_active = ?, updated_at = datetime(\'now\') WHERE id = ?').run(updates.is_active ? 1 : 0, providerId);
      }

      const row = getDb()
        .prepare('SELECT * FROM user_api_providers WHERE id = ?')
        .get(providerId) as ProviderRow;
      return rowToResponse(row);
    }
  );

  // ── Delete provider ───────────────────────────────────────────────────
  fastify.delete(
    '/v1/providers/:id',
    async (request: FastifyRequest<{ Params: { id: string } }>) => {
      const userId = request.user!.id;
      const providerId = (request.params as { id: string }).id;
      const result = getDb()
        .prepare('DELETE FROM user_api_providers WHERE id = ? AND user_id = ?')
        .run(providerId, userId);
      if (result.changes === 0) throw new InvalidRequestError('Provider not found');
      return { deleted: true };
    }
  );
}
