import { describe, expect, test } from 'vitest';
import { parseModelId } from '../packages/model-router/src/router.js';

describe('parseModelId', () => {
  test('parses provider/model format', () => {
    const result = parseModelId('openai/gpt-4');
    expect(result).toEqual({ provider: 'openai', model: 'gpt-4' });
  });

  test('parses nested model names', () => {
    const result = parseModelId('anthropic/claude-3.5-sonnet-20241022');
    expect(result.provider).toBe('anthropic');
    expect(result.model).toBe('claude-3.5-sonnet-20241022');
  });

  test('parses model with multiple slashes', () => {
    const result = parseModelId('litellm/openai/gpt-4');
    expect(result.provider).toBe('litellm');
    expect(result.model).toBe('openai/gpt-4');
  });

  test('throws on missing slash', () => {
    expect(() => parseModelId('gpt-4')).toThrow('Invalid model ID format');
  });

  test('throws on empty string', () => {
    expect(() => parseModelId('')).toThrow('Invalid model ID format');
  });

  test('handles provider with empty model', () => {
    const result = parseModelId('openai/');
    expect(result.provider).toBe('openai');
    expect(result.model).toBe('');
  });
});
