import { describe, expect, test } from 'vitest';
import { buildDisplayDescription } from '../packages/orchestrator/src/orchestrator/displayLabel.js';

describe('buildDisplayDescription', () => {
  test('adds natural prefix by agent type', () => {
    expect(buildDisplayDescription('runtime constraints for tauri apps', 'research')).toBe(
      'Researching runtime constraints for tauri apps'
    );
    expect(buildDisplayDescription('the final report', 'write')).toBe('Writing the final report');
    expect(buildDisplayDescription('settings view and tray icon', 'code')).toBe('Coding settings view and tray icon');
    expect(buildDisplayDescription('e2e validation for workflows', 'deep_research')).toBe(
      'Deep researching e2e validation for workflows'
    );
  });

  test('keeps already natural gerund phrasing', () => {
    expect(buildDisplayDescription('analyzing partner API response patterns', 'analyze')).toBe(
      'Analyzing partner API response patterns'
    );
  });

  test('strips imperative lead verb before prefixing', () => {
    expect(buildDisplayDescription('research hiring signals from 2024 reports', 'research')).toBe(
      'Researching hiring signals from 2024 reports'
    );
    expect(buildDisplayDescription('implement card redesign for menu bar', 'code')).toBe(
      'Coding card redesign for menu bar'
    );
  });
});
