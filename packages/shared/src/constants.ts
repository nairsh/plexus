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
