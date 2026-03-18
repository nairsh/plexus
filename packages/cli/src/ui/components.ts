/**
 * Reusable UI components for the CLI.
 * Uses chalk for colors and provides consistent patterns.
 */

import chalk, { type ChalkInstance } from 'chalk';
import ora, { type Ora } from 'ora';

// ── Color scheme ──

export const colors = {
  // Status colors
  success: chalk.green,
  warning: chalk.yellow,
  error: chalk.red,
  info: chalk.cyan,

  // Emphasis
  bold: chalk.bold,
  dim: chalk.dim,

  // UI elements
  highlight: chalk.magenta,
  muted: chalk.gray,
  link: chalk.blue.underline,

  // Agent colors (matching orchestrate.ts)
  research: chalk.blue,
  analyze: chalk.magenta,
  write: chalk.green,
  code: chalk.hex('#FF6B35'),
  file: chalk.gray,
};

// ── Status icons ──

export const icons = {
  success: chalk.green('✓'),
  warning: chalk.yellow('⚠'),
  error: chalk.red('✗'),
  info: chalk.cyan('●'),
  arrow: chalk.cyan('→'),
  bullet: chalk.white('•'),
  check: chalk.green('✓'),
  cross: chalk.red('✗'),
};

// ── Banner ──

export function printBanner(): void {
  // Block-style ASCII logo (white)
  console.log('');
  console.log(chalk.white('   ▄██████████████████▄'));
  console.log(chalk.white('   ██                ██'));
  console.log(chalk.white('   ██    ██    ██    ██'));
  console.log(chalk.white('   ██    ██    ██    ██'));
  console.log(chalk.white('   ██                ██'));
  console.log(chalk.white('   ▀██████████████████▀'));
  console.log(chalk.white('   ████████████████████'));
  console.log('');
  console.log(chalk.white.bold('   Orchestrator CLI'));
  console.log('');
}

// ── Section headers ──

export function printHeader(title: string): void {
  console.log('');
  console.log(chalk.bold.underline(title));
  console.log(chalk.dim('─'.repeat(title.length)));
}

export function printSubHeader(title: string): void {
  console.log('');
  console.log(chalk.bold(title));
}

// ── Status messages ──

export function printSuccess(message: string): void {
  console.log(`${icons.success} ${message}`);
}

export function printWarning(message: string): void {
  console.log(`${icons.warning} ${message}`);
}

export function printError(message: string): void {
  console.log(`${icons.error} ${message}`);
}

export function printInfo(message: string): void {
  console.log(`${icons.info} ${message}`);
}

// ── Key-value display ──

export function printKeyValue(key: string, value: string | undefined, status?: 'success' | 'warning' | 'error'): void {
  const icon =
    status === 'success'
      ? icons.success
      : status === 'warning'
        ? icons.warning
        : status === 'error'
          ? icons.error
          : '  ';
  const displayValue = value ?? chalk.dim('(not set)');
  console.log(`  ${icon} ${chalk.dim(key)}: ${displayValue}`);
}

export function printConfigItem(
  key: string,
  value: string | undefined,
  options?: { sensitive?: boolean; status?: 'success' | 'warning' | 'error' }
): void {
  const { sensitive = false, status } = options ?? {};
  const icon =
    status === 'success'
      ? icons.success
      : status === 'warning'
        ? icons.warning
        : status === 'error'
          ? icons.error
          : colors.muted('•');

  let displayValue: string;
  if (value === undefined || value === '') {
    displayValue = chalk.dim('(not set)');
  } else if (sensitive) {
    displayValue = chalk.dim('*'.repeat(Math.min(value.length, 8)));
  } else {
    displayValue = chalk.white(value);
  }

  console.log(`  ${icon} ${chalk.dim(key)}: ${displayValue}`);
}

// ── List display ──

export function printListItem(item: string, options?: { indent?: number; bullet?: string }): void {
  const indent = '  '.repeat(options?.indent ?? 0);
  const bullet = options?.bullet ?? colors.muted('•');
  console.log(`${indent}${bullet} ${item}`);
}

export function printModelItem(model: string, options?: { isDefault?: boolean; isSelected?: boolean }): void {
  const { isDefault = false, isSelected = false } = options ?? {};

  let prefix = colors.muted('•');
  if (isDefault) {
    prefix = icons.success;
  } else if (isSelected) {
    prefix = colors.info('●');
  }

  let display = chalk.white(model);
  if (isDefault) {
    display += chalk.green(' (default)');
  }

  console.log(`  ${prefix} ${display}`);
}

// ── Category display ──

export function printCategory(name: string): void {
  console.log('');
  console.log(chalk.bold(name));
}

// ── Summary display ──

export function printSummary(passed: number, warnings: number, failures: number): void {
  const parts: string[] = [];

  if (failures > 0) {
    parts.push(chalk.red(`${failures} failed`));
  }
  if (warnings > 0) {
    parts.push(chalk.yellow(`${warnings} warnings`));
  }
  parts.push(chalk.green(`${passed} passed`));

  console.log('');
  console.log(chalk.bold('Summary: ') + parts.join(', '));
}

// ── Spinner helpers ──

export function createSpinner(text: string): Ora {
  return ora({
    text,
    spinner: 'dots',
    color: 'cyan',
  });
}

export async function withSpinner<T>(text: string, fn: () => Promise<T>): Promise<T> {
  const spinner = createSpinner(text);
  spinner.start();

  try {
    const result = await fn();
    spinner.succeed();
    return result;
  } catch (error) {
    spinner.fail();
    throw error;
  }
}

// ── Error display ──

export function printErrorDetails(error: Error | string, context?: string): void {
  const message = typeof error === 'string' ? error : error.message;

  console.log('');
  if (context) {
    printError(`${context}: ${message}`);
  } else {
    printError(message);
  }

  // Show hint if available
  if (typeof error === 'object' && 'hint' in error && error.hint) {
    console.log(chalk.dim(`  Hint: ${error.hint as string}`));
  }
}

// ── Prompt helpers ──

export function formatPrompt(message: string, defaultValue?: string): string {
  let prompt = chalk.bold('?') + ' ' + chalk.white(message);
  if (defaultValue) {
    prompt += ' ' + chalk.dim(`(${defaultValue})`);
  }
  return prompt;
}

// ── Agent display ──

export function getAgentColor(agentType: string): ChalkInstance {
  const agentColors: Record<string, ChalkInstance> = {
    research: colors.research,
    analyze: colors.analyze,
    write: colors.write,
    code: colors.code,
    file: colors.file,
  };
  return agentColors[agentType] ?? chalk.white;
}

export function getAgentDisplayName(agentType: string): string {
  const names: Record<string, string> = {
    research: 'Research',
    analyze: 'Analysis',
    write: 'Writing',
    code: 'Code',
    file: 'File Ops',
  };
  return names[agentType] ?? agentType;
}

export function printAgentBadge(agentType: string): string {
  const color = getAgentColor(agentType);
  const name = getAgentDisplayName(agentType);
  return chalk.bold(color(`[${name}]`));
}
