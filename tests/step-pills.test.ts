import { describe, expect, test } from 'vitest';
import {
  latestStepPills,
  taskSubtitle,
  taskTitle,
  toolStepText,
  upsertStepPill,
  type StepPill,
} from '../packages/menubar/src/progress/stepPills.js';

describe('stepPills utilities', () => {
  test('formats task title in natural language', () => {
    expect(taskTitle('runtime constraints for tauri', 'research')).toBe('Researching runtime constraints for tauri');
    expect(taskTitle('coding tray icon update', 'code')).toBe('Coding tray icon update');
  });

  test('provides status-aware subtitle', () => {
    expect(taskSubtitle('running', 'research')).toBe('Compiling sources...');
    expect(taskSubtitle('completed', 'code')).toBe('Step complete');
    expect(taskSubtitle('failed', 'code')).toBe('Needs attention');
  });

  test('generates natural tool step text', () => {
    const webStep = toolStepText('web_search', { query: 'hiring market trends' });
    expect(webStep.title).toContain('Researching');
    expect(webStep.subtitle).toBe('Compiling sources...');

    const editStep = toolStepText('file_edit', { path: '/tmp/workflow.ts' });
    expect(editStep.title).toBe('Editing workflow.ts');
  });

  test('retains only latest three pills', () => {
    const initial: StepPill[] = [];
    const withOne = upsertStepPill(initial, {
      id: '1',
      title: 'One',
      subtitle: 'first',
      status: 'running',
      updatedAt: 1,
      source: 'task',
    });
    const withTwo = upsertStepPill(withOne, {
      id: '2',
      title: 'Two',
      subtitle: 'second',
      status: 'running',
      updatedAt: 2,
      source: 'task',
    });
    const withThree = upsertStepPill(withTwo, {
      id: '3',
      title: 'Three',
      subtitle: 'third',
      status: 'running',
      updatedAt: 3,
      source: 'task',
    });
    const withFour = upsertStepPill(withThree, {
      id: '4',
      title: 'Four',
      subtitle: 'fourth',
      status: 'running',
      updatedAt: 4,
      source: 'task',
    });

    const latest = latestStepPills(withFour, 3);
    expect(latest).toHaveLength(3);
    expect(latest.map((pill) => pill.id)).toEqual(['4', '3', '2']);
  });
});
