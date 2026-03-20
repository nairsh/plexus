import { describe, expect, it } from 'vitest';
import {
  extractHistoryEntries,
  extractTodoItemsFromTool,
  formatCompletionLabel,
  formatDuration,
  formatTokenCount,
  formatToolLabel,
  formatToolPreview,
  formatToolResultDetail,
  getToolResultStatus,
} from './chat-format.js';
import { getPromptRuntimeContext, loadPrompt } from '@orchestrator/orchestrator';
import { formatTableLines, parseInline, parseMarkdown } from './markdown.js';
import { createInitialState } from './chat-state.js';

const VISIBLE_TRANSCRIPT_LIMIT = 18;

const appendEntriesForScroll = (scrollOffset: number, addedEntries: number): number => {
  if (addedEntries <= 0) return scrollOffset;
  return scrollOffset > 0 ? scrollOffset + addedEntries : 0;
};

const visibleWindow = (transcriptLength: number, scrollOffset: number) => {
  const maxOffset = Math.max(0, transcriptLength - VISIBLE_TRANSCRIPT_LIMIT);
  const boundedOffset = Math.min(scrollOffset, maxOffset);
  const visibleStart = Math.max(0, transcriptLength - VISIBLE_TRANSCRIPT_LIMIT - boundedOffset);
  const visibleEnd = boundedOffset === 0 ? transcriptLength : transcriptLength - boundedOffset;
  return { visibleStart, visibleEnd };
};

describe('chat formatting', () => {
  it('formats token counts compactly', () => {
    expect(formatTokenCount(150)).toBe('150');
    expect(formatTokenCount(1_500)).toBe('1.5k');
    expect(formatTokenCount(2_500_000)).toBe('2.5M');
  });

  it('formats completion line as brewed for with credits', () => {
    expect(formatCompletionLabel(5_000, 0.125)).toBe('Brewed for 5s · 0.1250 credits');
    expect(formatCompletionLabel(5_000, 0.125, 1_500)).toBe('Brewed for 5s · 1.5k tokens · 0.1250 credits');
  });

  it('formats longer durations using minutes', () => {
    expect(formatDuration(138_000)).toBe('2m 18s');
  });

  it('formats tool previews for todos', () => {
    expect(formatToolPreview('write_todo', { description: 'Audit UI' })).toEqual({
      title: 'Created todo',
      detail: 'Audit UI',
    });
  });

  it('formats tool labels and results for terminal style rows', () => {
    expect(formatToolLabel('bash', { command: 'terraform fmt' })).toBe('Bash(terraform fmt)');
    expect(formatToolLabel('spawn_subagent', { description: 'Reply hello' })).toBe('Spawn subagent (Reply hello)');
    expect(formatToolLabel('web_search', { query: 'orchestrator platform' })).toBe('WebSearch(orchestrator platform)');
    expect(formatToolResultDetail('bash', { stdout: '', stderr: '', exit_code: 0 })).toBe('(No content)');
    expect(getToolResultStatus({ exit_code: 1, stderr: 'boom' })).toBe('error');
  });

  it('formats await_subagents output using natural labels', () => {
    expect(
      formatToolResultDetail('await_subagents', {
        completed_results: [{ description: 'Reply hello' }],
        completed: ['reply_hello'],
        running: [],
        failed: [],
      })
    ).toBe('Completed: Reply hello');
  });

  it('extracts todo items for todo tool rendering', () => {
    expect(
      extractTodoItemsFromTool('edit_todo', { todo_id: 'task-1', description: 'Ship UI', status: 'completed' })
    ).toEqual([{ id: 'task-1', description: 'Ship UI', status: 'completed' }]);
  });

  it('prefers todo descriptions over opaque ids', () => {
    expect(
      extractTodoItemsFromTool(
        'edit_todo',
        { todo_id: 'wf_123_task_1', status: 'completed' },
        { todo_id: 'wf_123_task_1', display_todo_id: 'task_1', description: 'Fix scrolling' }
      )
    ).toEqual([{ id: 'wf_123_task_1', description: 'Fix scrolling', status: 'completed' }]);
  });

  it('keeps scroll position pinned while new transcript entries arrive', () => {
    const state = createInitialState('test-model');
    state.transcript = Array.from({ length: 30 }, (_, index) => ({
      id: `entry-${index}`,
      type: 'system' as const,
      text: `Entry ${index}`,
    }));
    state.scrollOffset = 5;

    const nextOffset = appendEntriesForScroll(state.scrollOffset, 2);
    expect(nextOffset).toBe(7);

    const before = visibleWindow(state.transcript.length, state.scrollOffset);
    const after = visibleWindow(state.transcript.length + 2, nextOffset);
    expect(after.visibleStart).toBe(before.visibleStart);
    expect(after.visibleEnd).toBe(before.visibleEnd);
    expect(state.transcript.length + 2 - after.visibleEnd).toBe(state.transcript.length - before.visibleEnd + 2);
  });

  it('shows newer error output even while scrolled up', () => {
    const transcriptLength = 30;
    const before = visibleWindow(transcriptLength, 5);
    const afterOffset = appendEntriesForScroll(5, 1);
    const after = visibleWindow(transcriptLength + 1, afterOffset);
    expect(after.visibleStart).toBe(before.visibleStart);
    expect(transcriptLength + 1 - after.visibleEnd).toBe(transcriptLength - before.visibleEnd + 1);
  });
});

describe('history extraction', () => {
  it('keeps assistant and tool events', () => {
    const entries = extractHistoryEntries([
      {
        step_id: '1',
        workflow_id: 'wf',
        timestamp: new Date().toISOString(),
        step_type: 'orchestrator_message',
        model_name: null,
        message_content: 'hello',
        tool_name: null,
        tool_input: null,
        tool_output: null,
        subagent_id: 'orchestrator',
      },
      {
        step_id: '2',
        workflow_id: 'wf',
        timestamp: new Date().toISOString(),
        step_type: 'subagent_tool_call',
        model_name: null,
        message_content: null,
        tool_name: 'bash',
        tool_input: { command: 'pnpm test' },
        tool_output: null,
        subagent_id: 'code',
      },
    ]);

    expect(entries).toEqual([
      { type: 'assistant', text: 'hello' },
      { type: 'tool', toolName: 'bash', toolInput: { command: 'pnpm test' } },
    ]);
  });
});

describe('markdown parsing', () => {
  it('parses headings, tables, and code fences', () => {
    const blocks = parseMarkdown('# Title\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```ts\nconst x = 1\n```');
    expect(blocks.map((block) => block.type)).toEqual(['heading', 'table', 'code']);
  });

  it('keeps inline markdown parsing stable across repeated calls', () => {
    expect(parseInline('first **bold** pass')).toEqual([
      { type: 'text', text: 'first ' },
      { type: 'bold', text: 'bold' },
      { type: 'text', text: ' pass' },
    ]);

    expect(parseInline('second **again** pass')).toEqual([
      { type: 'text', text: 'second ' },
      { type: 'bold', text: 'again' },
      { type: 'text', text: ' pass' },
    ]);
  });

  it('formats tables as aligned terminal lines', () => {
    expect(
      formatTableLines([
        ['Area', 'Impact'],
        ['Mixture of Experts (MoE)', 'Enabled frontier-class models'],
      ])
    ).toEqual([
      '| Area                     | Impact                        |',
      '|--------------------------|-------------------------------|',
      '| Mixture of Experts (MoE) | Enabled frontier-class models |',
    ]);
  });

  it('truncates wide tables to fit the terminal width', () => {
    expect(
      formatTableLines(
        [
          ['Area', 'Impact'],
          ['Mixture of Experts (MoE)', 'Enabled frontier-class models'],
        ],
        50
      )
    ).toEqual([
      '| Area                | Impact                   |',
      '|---------------------|--------------------------|',
      '| Mixture of Exper... | Enabled frontier-clas... |',
    ]);
  });
});

describe('prompt runtime context', () => {
  it('injects time variables and litellm backend label', () => {
    const runtime = getPromptRuntimeContext(new Date('2026-03-17T12:34:56.000Z'));
    const prompt = loadPrompt('code.md', {
      currentDate: runtime.currentDate,
      currentTime: runtime.currentTime,
      currentDateTime: runtime.currentDateTime,
      currentTimezone: runtime.currentTimezone,
      nowIso: runtime.nowIso,
      modelBackend: runtime.modelBackend,
      agentType: 'code',
    });

    expect(prompt).toContain('Active model backend: LiteLLM');
    expect(prompt).toContain('Active agent type: code');
    expect(prompt).not.toContain('{{currentDate}}');
    expect(prompt).not.toContain('{{modelBackend}}');
  });
});
