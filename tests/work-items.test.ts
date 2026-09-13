import { describe, expect, test } from 'vitest';
import { getWorkItemDisplayId, resolveWorkItemId } from '../packages/orchestrator/src/workItems.js';

const WF_ID = 'wf-abc123';

describe('resolveWorkItemId', () => {
  test('returns id as-is if already prefixed', () => {
    expect(resolveWorkItemId(WF_ID, `${WF_ID}_task-1`)).toBe(`${WF_ID}_task-1`);
  });

  test('prepends workflow prefix when missing', () => {
    expect(resolveWorkItemId(WF_ID, 'task-1')).toBe(`${WF_ID}_task-1`);
  });

  test('does not double-prefix', () => {
    const full = `${WF_ID}_task-1`;
    expect(resolveWorkItemId(WF_ID, full)).toBe(full);
  });
});

describe('getWorkItemDisplayId', () => {
  test('strips workflow prefix', () => {
    expect(getWorkItemDisplayId(WF_ID, `${WF_ID}_task-1`)).toBe('task-1');
  });

  test('returns id unchanged if no prefix present', () => {
    expect(getWorkItemDisplayId(WF_ID, 'task-1')).toBe('task-1');
  });

  test('only strips prefix once', () => {
    const double = `${WF_ID}_${WF_ID}_task-1`;
    expect(getWorkItemDisplayId(WF_ID, double)).toBe(`${WF_ID}_task-1`);
  });
});
