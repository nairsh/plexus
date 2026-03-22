/**
 * Centralized, Zod-validated environment variable access.
 *
 * Call getEnv() anywhere to get a fully-typed, defaulted env object.
 * Validation runs once on first call and is cached.
 */
import { z } from 'zod';

const EnvSchema = z.object({
  // ── Core ──
  NODE_ENV: z.string().default('development'),
  LOG_LEVEL: z.string().default('info'),
  PORT: z.coerce.number().int().positive().default(8080),

  // ── Database ──
  DATABASE_PATH: z.string().default('./data/orchestrator.db'),
  STORAGE_BACKEND: z.enum(['sqlite', 'convex']).default('sqlite'),
  CONVEX_URL: z.string().optional(),
  CONVEX_ADMIN_KEY: z.string().optional(),
  MAINTENANCE_MODE: z
    .string()
    .optional()
    .transform((value) => value === '1' || value === 'true'),
  BILLING_MODE: z.enum(['enforced', 'observe', 'disabled']).default('disabled'),

  // ── Auth (Clerk) ──
  CLERK_SECRET_KEY: z.string().optional(),
  CLERK_PUBLISHABLE_KEY: z.string().optional(),
  CLERK_JWT_KEY: z.string().optional(),
  CLERK_AUDIENCE: z.string().optional(),
  CLERK_AUTHORIZED_PARTIES: z.string().optional(),
  CLERK_CLOCK_SKEW_MS: z.coerce.number().int().nonnegative().default(5000),

  // ── LLM providers ──
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  GOOGLE_AI_API_KEY: z.string().optional(),
  LITELLM_BASE_URL: z.string().default('http://localhost:4000'),
  LITELLM_API_KEY: z.string().default('sk-litellm'),

  // ── Search tools ──
  TAVILY_API_KEY: z.string().optional(),
  TAVILY_BASE_URL: z.string().default('https://api.tavily.com'),
  TAVILY_RATE_LIMIT_MS: z.coerce.number().int().nonnegative().default(300),
  BRAVE_SEARCH_API_KEY: z.string().optional(),

  // ── Skills ──
  CLAUDE_SKILLS_PATH: z.string().optional(),

  // ── Sandbox ──
  SANDBOX_WORKSPACE_ROOT: z.string().default('./data/workspaces'),
  SANDBOX_MAX_TIMEOUT: z.coerce.number().int().positive().default(3600),
  SANDBOX_DEFAULT_TIMEOUT: z.coerce.number().int().positive().default(300),

  // ── OpenTerminal container ──
  OPEN_TERMINAL_IMAGE: z.string().default('ghcr.io/open-webui/open-terminal:slim'),
  OPEN_TERMINAL_HOST: z.string().default('127.0.0.1'),
  OPEN_TERMINAL_START_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),

  // ── System passthrough (for sandbox child process env) ──
  PATH: z.string().default('/usr/local/bin:/usr/bin:/bin'),
  HOME: z.string().default('/home/user'),
  LANG: z.string().default('en_US.UTF-8'),
  TERM: z.string().default('xterm'),
});

export type Env = z.infer<typeof EnvSchema>;

let _env: Env | null = null;

/** Returns a validated, fully-defaulted environment object. Cached after first call. */
export function getEnv(): Env {
  if (!_env) {
    _env = EnvSchema.parse(process.env);
  }
  return _env;
}

/** Reset cached env — useful in tests that mutate process.env. */
export function resetEnvCache(): void {
  _env = null;
}
