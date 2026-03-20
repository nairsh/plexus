import { describe, expect, test } from 'vitest';
import {
  DEFAULT_CREDIT_BALANCE,
  DEFAULT_LLM_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_TEMPERATURE,
  MAX_EVENT_LISTENERS,
  MAX_OUTPUT_LENGTH,
  MAX_TOOL_ITERATIONS,
  ORCHESTRATOR_MAX_OUTPUT_TOKENS,
  RESEARCH_TEMPERATURE,
  TRUNCATED_OUTPUT_LENGTH,
  WRITE_TEMPERATURE,
} from '@orchestrator/shared';

describe('shared constants', () => {
  test('token limits are positive integers', () => {
    expect(DEFAULT_MAX_OUTPUT_TOKENS).toBeGreaterThan(0);
    expect(ORCHESTRATOR_MAX_OUTPUT_TOKENS).toBeGreaterThan(0);
    expect(Number.isInteger(DEFAULT_MAX_OUTPUT_TOKENS)).toBe(true);
    expect(Number.isInteger(ORCHESTRATOR_MAX_OUTPUT_TOKENS)).toBe(true);
  });

  test('temperatures are in [0, 1]', () => {
    for (const t of [DEFAULT_TEMPERATURE, WRITE_TEMPERATURE, RESEARCH_TEMPERATURE]) {
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(1);
    }
  });

  test('output lengths are consistent (truncated < max)', () => {
    expect(TRUNCATED_OUTPUT_LENGTH).toBeLessThan(MAX_OUTPUT_LENGTH);
  });

  test('tool iteration limit is positive', () => {
    expect(MAX_TOOL_ITERATIONS).toBeGreaterThan(0);
  });

  test('LLM timeout is at least 30 seconds', () => {
    expect(DEFAULT_LLM_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
  });

  test('billing defaults are positive', () => {
    expect(DEFAULT_CREDIT_BALANCE).toBeGreaterThan(0);
  });

  test('event listener limit is positive', () => {
    expect(MAX_EVENT_LISTENERS).toBeGreaterThan(0);
  });
});
