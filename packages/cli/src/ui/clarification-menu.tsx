import React from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { uiTheme } from './theme.js';
import type { ClarificationOption } from './chat-state.js';

interface ClarificationMenuProps {
  question: string;
  options?: ClarificationOption[];
  allowCustom: boolean;
  onSelect: (value: string) => void;
  onSkip: () => void;
}

export const ClarificationMenu = ({
  question,
  options,
  allowCustom,
  onSelect,
  onSkip,
}: ClarificationMenuProps) => {
  const hasOptions = options !== undefined && options.length > 0;
  const customIndex = hasOptions ? options.length : 0;
  const totalItems = customIndex + (allowCustom ? 1 : 0);

  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const [customValue, setCustomValue] = React.useState('');
  const { stdout } = useStdout();
  const width = Math.max(40, stdout.columns || 80);
  const innerWidth = Math.min(width - 4, 72);

  const isOnCustom = hasOptions ? selectedIndex === customIndex : true;
  const isFreeTextOnly = !hasOptions;

  useInput((input, key) => {
    if (key.escape) {
      onSkip();
      return;
    }

    // ── Free-text only mode (no predefined options) ──
    if (isFreeTextOnly) {
      if (key.return) {
        if (customValue.trim()) {
          onSelect(customValue.trim());
        }
        return;
      }

      if (key.backspace || key.delete) {
        setCustomValue((prev) => prev.slice(0, -1));
        return;
      }

      if (key.ctrl && input === 'u') {
        setCustomValue('');
        return;
      }

      if (input && !key.ctrl && !key.meta && !key.upArrow && !key.downArrow) {
        setCustomValue((prev) => prev + input);
      }
      return;
    }

    // ── Options mode: currently on the "Something else" custom input ──
    if (isOnCustom) {
      if (key.return) {
        if (customValue.trim()) {
          onSelect(customValue.trim());
        }
        return;
      }

      if (key.upArrow) {
        setSelectedIndex((prev) => Math.max(0, prev - 1));
        return;
      }

      if (key.backspace || key.delete) {
        setCustomValue((prev) => prev.slice(0, -1));
        return;
      }

      if (key.ctrl && input === 'u') {
        setCustomValue('');
        return;
      }

      if (input && !key.ctrl && !key.meta && !key.upArrow && !key.downArrow) {
        setCustomValue((prev) => prev + input);
      }
      return;
    }

    // ── Options mode: on a predefined option ──
    if (key.upArrow) {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
      return;
    }

    if (key.downArrow) {
      setSelectedIndex((prev) => Math.min(totalItems - 1, prev + 1));
      return;
    }

    if (key.return && hasOptions && options[selectedIndex]) {
      onSelect(options[selectedIndex].label);
      return;
    }

    // Number keys for quick-select (1–9)
    if (hasOptions && input >= '1' && input <= '9') {
      const num = parseInt(input, 10) - 1;
      if (num < options.length) {
        onSelect(options[num].label);
      }
    }
  });

  // ── Free-text only mode ──
  if (isFreeTextOnly) {
    return (
      <Box flexDirection="column" marginTop={1} marginBottom={1}>
        <Text color={uiTheme.borderStrong}>{'─'.repeat(innerWidth)}</Text>
        <Box marginTop={1} marginBottom={1}>
          <Text color={uiTheme.accent} bold>
            {'? '}
          </Text>
          <Text color={uiTheme.text} bold>
            {question}
          </Text>
        </Box>
        <Box>
          <Text color={uiTheme.muted}>{'❯ '}</Text>
          <Text color={uiTheme.text}>{customValue}</Text>
          <Text backgroundColor={uiTheme.accentSoft} color={uiTheme.codeBg}>
            {' '}
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text color={uiTheme.faint}>Enter to submit · Esc to skip</Text>
        </Box>
        <Text color={uiTheme.borderStrong}>{'─'.repeat(innerWidth)}</Text>
      </Box>
    );
  }

  // ── Options mode ──
  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      <Text color={uiTheme.borderStrong}>{'─'.repeat(innerWidth)}</Text>
      <Box marginTop={1} marginBottom={1}>
        <Text color={uiTheme.accent} bold>
          {'? '}
        </Text>
        <Text color={uiTheme.text} bold>
          {question}
        </Text>
      </Box>

      <Box flexDirection="column">
        {options.map((option, index) => {
          const selected = index === selectedIndex;
          return (
            <Box key={`opt-${option.label}-${index}`} flexDirection="column">
              <Box>
                <Text color={selected ? uiTheme.accent : uiTheme.faint}>
                  {selected ? '▸ ' : '  '}
                </Text>
                <Text color={selected ? uiTheme.accentSoft : uiTheme.faint} bold>
                  {`${index + 1} `}
                </Text>
                <Text color={selected ? uiTheme.text : uiTheme.muted}>
                  {option.label}
                </Text>
                {selected ? (
                  <Text color={uiTheme.faint}>{' ⏎'}</Text>
                ) : null}
              </Box>
              {option.description ? (
                <Box marginLeft={4}>
                  <Text color={uiTheme.faint}>{option.description}</Text>
                </Box>
              ) : null}
              {index < options.length - 1 || allowCustom ? (
                <Box marginLeft={2}>
                  <Text color={uiTheme.border}>
                    {'─'.repeat(Math.max(0, innerWidth - 4))}
                  </Text>
                </Box>
              ) : null}
            </Box>
          );
        })}

        {allowCustom ? (
          <Box marginTop={1}>
            <Text color={isOnCustom ? uiTheme.accent : uiTheme.faint}>
              {isOnCustom ? '▸ ' : '  '}
            </Text>
            <Text color={uiTheme.faint}>{'✏ '}</Text>
            {isOnCustom ? (
              <>
                <Text color={uiTheme.text}>{customValue}</Text>
                <Text backgroundColor={uiTheme.accentSoft} color={uiTheme.codeBg}>
                  {' '}
                </Text>
              </>
            ) : (
              <Text color={uiTheme.faint} dimColor>
                Something else
              </Text>
            )}
          </Box>
        ) : null}
      </Box>

      <Box marginTop={1}>
        <Text color={uiTheme.faint}>
          {'↑↓ to navigate · Enter to select · Esc to skip'}
        </Text>
      </Box>
      <Text color={uiTheme.borderStrong}>{'─'.repeat(innerWidth)}</Text>
    </Box>
  );
};
