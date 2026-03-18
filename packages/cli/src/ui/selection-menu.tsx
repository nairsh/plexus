import React from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { uiTheme } from './theme.js';

export interface SelectionOption {
  id: string;
  label: string;
  description?: string;
  tag?: string;
}

interface SelectionMenuProps {
  title: string;
  subtitle: string;
  options: SelectionOption[];
  onSelect: (id: string) => void;
  onCancel: () => void;
}

export const SelectionMenu = ({ title, subtitle, options, onSelect, onCancel }: SelectionMenuProps) => {
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const { stdout } = useStdout();
  const width = Math.max(40, stdout.columns || 80);
  const visibleOptions = options.slice(0, 10);

  const truncate = (value: string, maxWidth: number): string => {
    if (value.length <= maxWidth) return value;
    return `${value.slice(0, Math.max(0, maxWidth - 1))}…`;
  };

  useInput((_input, key) => {
    if (key.upArrow) {
      setSelectedIndex((current) => Math.max(0, current - 1));
      return;
    }

    if (key.downArrow) {
      setSelectedIndex((current) => Math.min(visibleOptions.length - 1, current + 1));
      return;
    }

    if (key.return && options[selectedIndex]) {
      onSelect(visibleOptions[selectedIndex].id);
      return;
    }

    if (key.escape) {
      onCancel();
    }
  });

  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      <Text color={uiTheme.borderStrong}>{'─'.repeat(72)}</Text>
      <Text color={uiTheme.accentSoft} bold>
        {title}
      </Text>
      <Text color={uiTheme.faint}>{subtitle}</Text>
      <Box flexDirection="column" marginTop={1}>
        {visibleOptions.map((option, index) => {
          const selected = index === selectedIndex;
          return (
            <Box key={option.id} flexDirection="column" marginBottom={option.description ? 1 : 0}>
              <Box>
                <Text color={selected ? uiTheme.accent : uiTheme.faint}>{selected ? '▸ ' : '  '}</Text>
                <Text color={selected ? uiTheme.text : uiTheme.muted}>{truncate(option.label, width - 10)}</Text>
                {option.tag ? <Text color={uiTheme.success}>{`  ${option.tag}`}</Text> : null}
              </Box>
              {option.description ? (
                <Box>
                  <Text color={uiTheme.faint}>{'  '}</Text>
                  <Text color={uiTheme.faint}>{truncate(option.description, width - 6)}</Text>
                </Box>
              ) : null}
            </Box>
          );
        })}
      </Box>
      <Text color={uiTheme.faint}>
        Enter to confirm · Esc to cancel
      </Text>
      <Text color={uiTheme.borderStrong}>{'─'.repeat(72)}</Text>
    </Box>
  );
};
