/**
 * Shared constants used across the orchestrator platform.
 * Centralizing these prevents magic numbers and makes tuning easier.
 */

// ── LLM output tokens ──
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
export const ORCHESTRATOR_MAX_OUTPUT_TOKENS = 4096;

// ── Temperature ──
export const DEFAULT_TEMPERATURE = 0.2;
export const WRITE_TEMPERATURE = 0.3;
export const RESEARCH_TEMPERATURE = 0.1;

// ── Orchestrator loop ──
export const MAX_TOOL_ITERATIONS = 10;

// ── Timeouts ──
export const DEFAULT_LLM_TIMEOUT_MS = 120_000;

// ── Output truncation ──
export const MAX_OUTPUT_LENGTH = 10_000;
export const TRUNCATED_OUTPUT_LENGTH = 1_000;

// ── Billing defaults ──
export const DEFAULT_CREDIT_BALANCE = 10_000;

// ── Event emitter ──
export const MAX_EVENT_LISTENERS = 100;

// ── Subagent harness ──
export const SUBAGENT_DEFAULT_TIMEOUT_S = 300;
export const SUBAGENT_LONG_RUNNING_TIMEOUT_S = 1800;
export const SUBAGENT_MAX_RETRIES = 2;
export const SUBAGENT_MAX_ITERATIONS = 20;
export const SUBAGENT_PROGRESS_INTERVAL_MS = 30_000;

// ── LSP / Lint ──
export const LINT_CHECK_TIMEOUT_MS = 15_000;
export const LINT_SUPPORTED_LANGUAGES = ['typescript', 'javascript', 'python'] as const;
export type LintLanguage = (typeof LINT_SUPPORTED_LANGUAGES)[number];

// ── Teams (beta) ──
export const TEAMS_FEATURE_FLAG = 'teams_beta';
export const MAX_TEAM_MEMBERS = 50;
export const MAX_TEAM_SHARED_CONTEXTS = 100;
