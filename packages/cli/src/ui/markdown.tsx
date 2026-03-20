import React from 'react';
import { Box, Text, useStdout } from 'ink';
import { uiTheme } from './theme.js';

type InlineSegment =
  | { type: 'text'; text: string }
  | { type: 'bold'; text: string }
  | { type: 'italic'; text: string }
  | { type: 'code'; text: string };

type MarkdownBlock =
  | { type: 'paragraph'; lines: string[] }
  | { type: 'heading'; level: number; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'blockquote'; lines: string[] }
  | { type: 'code'; language?: string; lines: string[] }
  | { type: 'table'; rows: string[][] };

const INLINE_PATTERN = /(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(`([^`]+)`)/g;

export const parseInline = (text: string): InlineSegment[] => {
  const segments: InlineSegment[] = [];
  let index = 0;
  let match: RegExpExecArray | null;

  INLINE_PATTERN.lastIndex = 0;

  while ((match = INLINE_PATTERN.exec(text)) !== null) {
    if (match.index > index) {
      segments.push({ type: 'text', text: text.slice(index, match.index) });
    }

    if (match[1]) {
      segments.push({ type: 'bold', text: match[2] });
    } else if (match[3]) {
      segments.push({ type: 'italic', text: match[4] });
    } else if (match[5]) {
      segments.push({ type: 'code', text: match[6] });
    }

    index = match.index + match[0].length;
  }

  if (index < text.length) {
    segments.push({ type: 'text', text: text.slice(index) });
  }

  return segments.length > 0 ? segments : [{ type: 'text', text }];
};

const isTableDivider = (line: string): boolean => {
  const trimmed = line.trim();
  return /^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?$/.test(trimmed);
};

const splitTableRow = (line: string): string[] => {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
};

export const parseMarkdown = (input: string): MarkdownBlock[] => {
  const lines = input.replace(/\r\n/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];

  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';

    if (!line.trim()) {
      index += 1;
      continue;
    }

    const codeFence = line.match(/^```(.*)$/);
    if (codeFence) {
      const language = codeFence[1]?.trim() || undefined;
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index]?.startsWith('```')) {
        codeLines.push(lines[index] ?? '');
        index += 1;
      }
      index += 1;
      blocks.push({ type: 'code', language, lines: codeLines });
      continue;
    }

    if (line.includes('|') && index + 1 < lines.length && isTableDivider(lines[index + 1] ?? '')) {
      const rows = [splitTableRow(line)];
      index += 2;
      while (index < lines.length && (lines[index] ?? '').includes('|')) {
        rows.push(splitTableRow(lines[index] ?? ''));
        index += 1;
      }
      blocks.push({ type: 'table', rows });
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] });
      index += 1;
      continue;
    }

    if (line.startsWith('> ')) {
      const quoteLines: string[] = [];
      while (index < lines.length && (lines[index] ?? '').startsWith('> ')) {
        quoteLines.push((lines[index] ?? '').slice(2));
        index += 1;
      }
      blocks.push({ type: 'blockquote', lines: quoteLines });
      continue;
    }

    if (/^\s*([-*+]\s+)/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items: string[] = [];
      while (index < lines.length) {
        const current = lines[index] ?? '';
        const match = ordered
          ? current.match(/^\s*\d+\.\s+(.*)$/)
          : current.match(/^\s*[-*+]\s+(.*)$/);
        if (!match) break;
        items.push(match[1]);
        index += 1;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? '';
      if (!current.trim()) break;
      if (
        current.startsWith('```') ||
        current.startsWith('> ') ||
        /^#{1,6}\s+/.test(current) ||
        /^\s*([-*+]\s+)/.test(current) ||
        /^\s*\d+\.\s+/.test(current) ||
        (current.includes('|') && index + 1 < lines.length && isTableDivider(lines[index + 1] ?? ''))
      ) {
        break;
      }
      paragraph.push(current);
      index += 1;
    }
    blocks.push({ type: 'paragraph', lines: paragraph });
  }

  return blocks;
};

const InlineText = ({ text }: { text: string }) => {
  const segments = parseInline(text);
  return (
    <Text color={uiTheme.text}>
      {segments.map((segment, index) => {
        if (segment.type === 'bold') {
          return (
            <Text key={index} color={uiTheme.accent} bold>
              {segment.text}
            </Text>
          );
        }

        if (segment.type === 'italic') {
          return (
            <Text key={index} color={uiTheme.text} italic>
              {segment.text}
            </Text>
          );
        }

        if (segment.type === 'code') {
          return (
            <Text key={index} color={uiTheme.codeText}>
              {` ${segment.text} `}
            </Text>
          );
        }

        return (
          <Text key={index} color={uiTheme.text}>
            {segment.text}
          </Text>
        );
      })}
    </Text>
  );
};

const pad = (text: string, width: number): string => text.padEnd(width, ' ');

const truncateCell = (value: string, width: number): string => {
  if (value.length <= width) return value;
  if (width <= 3) return value.slice(0, width);
  return `${value.slice(0, width - 3)}...`;
};

const fitColumnWidths = (naturalWidths: number[], maxWidth: number): number[] => {
  if (naturalWidths.length === 0) return [];

  const overhead = naturalWidths.length * 3 + 1;
  const contentBudget = maxWidth - overhead;
  if (contentBudget <= 0) {
    return naturalWidths.map(() => 1);
  }

  const totalNatural = naturalWidths.reduce((sum, width) => sum + width, 0);
  if (totalNatural <= contentBudget) {
    return naturalWidths;
  }

  const scaled = naturalWidths.map((width) => Math.max(1, Math.floor((width / totalNatural) * contentBudget)));
  let remaining = contentBudget - scaled.reduce((sum, width) => sum + width, 0);

  const remainders = naturalWidths
    .map((width, index) => ({ index, remainder: (width / totalNatural) * contentBudget - scaled[index]! }))
    .sort((a, b) => b.remainder - a.remainder);

  for (const entry of remainders) {
    if (remaining <= 0) break;
    scaled[entry.index] += 1;
    remaining -= 1;
  }

  return scaled;
};

export const formatTableLines = (rows: string[][], maxWidth = Number.POSITIVE_INFINITY): string[] => {
  if (rows.length === 0) return [];

  const columnCount = Math.max(...rows.map((row) => row.length));
  const naturalWidths = Array.from({ length: columnCount }, (_, index) =>
    Math.max(...rows.map((row) => row[index]?.length ?? 0)),
  );
  const widths = Number.isFinite(maxWidth) ? fitColumnWidths(naturalWidths, Math.max(20, Math.floor(maxWidth))) : naturalWidths;

  return rows.flatMap((row, rowIndex) => {
    const content = widths
      .map((width, columnIndex) => {
        const cell = truncateCell(row[columnIndex] ?? '', width);
        return ` ${pad(cell, width)} `;
      })
      .join('|');
    const line = `|${content}|`;
    if (rowIndex === 0) {
      const separator = `|${widths.map((width) => '-'.repeat(width + 2)).join('|')}|`;
      return [line, separator];
    }

    return [line];
  });
};

export const MarkdownMessage = ({ text, prefix = '●  ' }: { text: string; prefix?: string }) => {
  const { stdout } = useStdout();
  const maxWidth = Math.max(40, stdout.columns || 80);
  const blocks = parseMarkdown(text);

  return (
    <Box flexDirection="column" marginBottom={1}>
      {blocks.map((block, blockIndex) => {
        const showPrefix = blockIndex === 0;
        const left = showPrefix ? prefix : '   ';

        if (block.type === 'heading') {
          return (
            <Box key={blockIndex}>
              <Text color={uiTheme.text}>{left}</Text>
              <Text color={uiTheme.accentSoft} bold>
                {block.text}
              </Text>
            </Box>
          );
        }

        if (block.type === 'list') {
          return (
            <Box key={blockIndex} flexDirection="column">
              {block.items.map((item, itemIndex) => (
                <Box key={itemIndex}>
                  <Text color={uiTheme.text}>{itemIndex === 0 ? left : '   '}</Text>
                  <Text color={uiTheme.muted}>{block.ordered ? `${itemIndex + 1}. ` : '• '}</Text>
                  <InlineText text={item} />
                </Box>
              ))}
            </Box>
          );
        }

        if (block.type === 'blockquote') {
          return (
            <Box key={blockIndex} flexDirection="column">
              {block.lines.map((line, lineIndex) => (
                <Box key={lineIndex}>
                  <Text color={uiTheme.text}>{lineIndex === 0 ? left : '   '}</Text>
                  <Text color={uiTheme.borderStrong}>{'│ '}</Text>
                  <InlineText text={line} />
                </Box>
              ))}
            </Box>
          );
        }

        if (block.type === 'code') {
          return (
            <Box key={blockIndex} flexDirection="column" marginBottom={1}>
              <Box>
                <Text color={uiTheme.text}>{left}</Text>
                <Text color={uiTheme.faint}>{block.language ? `code · ${block.language}` : 'code'}</Text>
              </Box>
              {block.lines.map((line, lineIndex) => (
                <Box key={lineIndex}>
                  <Text color={uiTheme.text}>{'   '}</Text>
                  <Text color={uiTheme.codeBorder}>{'│ '}</Text>
                  <Text color={uiTheme.codeText}>
                    {line || ' '}
                  </Text>
                </Box>
              ))}
            </Box>
          );
        }

        if (block.type === 'table') {
          const lines = formatTableLines(block.rows, maxWidth - prefix.length - 3);

          return (
            <Box key={blockIndex} flexDirection="column">
              <Box>
                <Text color={uiTheme.text}>{left}</Text>
                <Text color={uiTheme.faint}>table</Text>
              </Box>
              {lines.map((line, lineIndex) => (
                <Box key={`${blockIndex}-${lineIndex}`}>
                  <Text color={uiTheme.text}>{'   '}</Text>
                  <Text
                    color={lineIndex === 0 ? uiTheme.accentSoft : lineIndex === 1 ? uiTheme.borderStrong : uiTheme.text}
                    wrap="truncate-end"
                  >
                    {line}
                  </Text>
                </Box>
              ))}
            </Box>
          );
        }

        return (
          <Box key={blockIndex} flexDirection="column">
            {block.lines.map((line, lineIndex) => (
              <Box key={lineIndex}>
                <Text color={uiTheme.text}>{lineIndex === 0 ? left : '   '}</Text>
                <InlineText text={line} />
              </Box>
            ))}
          </Box>
        );
      })}
    </Box>
  );
};
