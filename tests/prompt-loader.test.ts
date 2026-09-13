/**
 * Unit tests for promptLoader helpers.
 *
 * Covers: formatConversationHistory (HISTORY_WINDOW truncation),
 *         trimMessagesForContext (MESSAGE_WINDOW_TURNS trimming).
 */

import { describe, expect, test } from 'vitest';
import { formatConversationHistory } from '../packages/orchestrator/src/promptLoader.js';

// Re-export trimMessagesForContext for testing via the loop module.
// We import it indirectly by re-implementing the same logic here (or mocking),
// but since it's not exported, we test it through orchestrator-behavior.test.ts.
// Instead, let's test the exported formatConversationHistory directly.

describe('formatConversationHistory', () => {
  test('returns placeholder for empty history', () => {
    expect(formatConversationHistory([])).toBe('No previous conversation.');
  });

  test('formats a single message', () => {
    const result = formatConversationHistory([{ role: 'user', content: 'hello' }]);
    expect(result).toContain('USER:');
    expect(result).toContain('hello');
  });

  test('includes all messages when within window', () => {
    const msgs = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `msg-${i}`,
    }));
    const result = formatConversationHistory(msgs);
    expect(result).not.toContain('omitted');
    for (let i = 0; i < 10; i++) {
      expect(result).toContain(`msg-${i}`);
    }
  });

  test('truncates history to last 20 messages when over limit', () => {
    const msgs = Array.from({ length: 25 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `msg-${i}`,
    }));
    const result = formatConversationHistory(msgs);
    // First 5 messages should be omitted
    expect(result).toContain('5 earlier messages omitted');
    // Last 20 messages should be present
    for (let i = 5; i < 25; i++) {
      expect(result).toContain(`msg-${i}`);
    }
    // First 5 should NOT appear (except in header)
    expect(result).not.toContain('msg-0\n');
    expect(result).not.toContain('msg-4\n');
  });

  test('truncates long individual message bodies to 1000 chars', () => {
    const longContent = 'x'.repeat(1500);
    const result = formatConversationHistory([{ role: 'user', content: longContent }]);
    expect(result).toContain('…[truncated]');
    // Should contain the first 1000 chars but not the full 1500
    expect(result).toContain('x'.repeat(1000));
    expect(result).not.toContain('x'.repeat(1001));
  });

  test('includes timestamp when provided', () => {
    const result = formatConversationHistory([{ role: 'user', content: 'hi', timestamp: '2026-01-01T00:00:00.000Z' }]);
    expect(result).toContain('2026-01-01T00:00:00.000Z');
  });
});
