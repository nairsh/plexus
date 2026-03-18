/**
 * Interactive prompt utilities using @inquirer/prompts.
 */

import { input, password, select, checkbox, confirm } from '@inquirer/prompts';
import chalk from 'chalk';

// ── Types ──

export interface PromptOptions {
  default?: string;
  validate?: (value: string) => boolean | string | Promise<boolean | string>;
}

export interface SelectOption<T = string> {
  value: T;
  name: string;
  description?: string;
  disabled?: boolean;
}

// ── Basic prompts ──

export async function promptText(message: string, options?: PromptOptions): Promise<string> {
  return input({
    message: chalk.white(message),
    default: options?.default,
    validate: options?.validate,
  });
}

export async function promptPassword(message: string, options?: Omit<PromptOptions, 'default'>): Promise<string> {
  return password({
    message: chalk.white(message),
    validate: options?.validate,
  });
}

export async function promptConfirm(message: string, options?: { default?: boolean }): Promise<boolean> {
  return confirm({
    message: chalk.white(message),
    default: options?.default ?? false,
  });
}

export async function promptSelect<T = string>(message: string, choices: SelectOption<T>[]): Promise<T> {
  return select({
    message: chalk.white(message),
    choices: choices.map((c) => ({
      value: c.value,
      name: c.disabled ? chalk.dim(c.name) + chalk.dim(' (unavailable)') : c.name,
      description: c.description,
      disabled: c.disabled,
    })),
  });
}

export async function promptMultiSelect<T = string>(
  message: string,
  choices: SelectOption<T>[],
  options?: { min?: number; max?: number }
): Promise<T[]> {
  // Note: min/max validation done manually since @inquirer/prompts may not support them
  const result = await checkbox({
    message: chalk.white(message),
    choices: choices.map((c) => ({
      value: c.value,
      name: c.disabled ? chalk.dim(c.name) + chalk.dim(' (unavailable)') : c.name,
      description: c.description,
      disabled: c.disabled,
    })),
  });

  // Manual validation for min
  if (options?.min && result.length < options.min) {
    throw new Error(`At least ${options.min} selection(s) required`);
  }

  return result as T[];
}

// ── Specialized prompts ──

export async function promptUrl(message: string, options?: { default?: string }): Promise<string> {
  return promptText(message, {
    default: options?.default,
    validate: (value) => {
      if (!value) return 'URL is required';
      try {
        new URL(value);
        return true;
      } catch {
        return 'Please enter a valid URL';
      }
    },
  });
}

export async function promptApiKey(message: string, options?: { required?: boolean }): Promise<string> {
  return promptPassword(message, {
    validate: (value) => {
      if (options?.required !== false && !value) {
        return 'API key is required';
      }
      return true;
    },
  });
}

export async function promptModel(message: string, models: string[], options?: { default?: string }): Promise<string> {
  const choices: SelectOption[] = models.map((model) => ({
    value: model,
    name: model,
  }));

  // Move default to top if specified
  if (options?.default) {
    const defaultIndex = choices.findIndex((c) => c.value === options.default);
    if (defaultIndex > 0) {
      const [defaultChoice] = choices.splice(defaultIndex, 1);
      choices.unshift(defaultChoice);
    }
  }

  return promptSelect(message, choices);
}

export async function promptModels(
  message: string,
  models: string[],
  options?: { default?: string[]; min?: number }
): Promise<string[]> {
  const choices: SelectOption[] = models.map((model) => ({
    value: model,
    name: model,
    checked: options?.default?.includes(model),
  }));

  return promptMultiSelect(message, choices, { min: options?.min });
}

// ── Retry prompt ──

export async function promptRetry(message: string, error: string): Promise<'retry' | 'skip' | 'abort'> {
  return promptSelect(`${message} ${chalk.red(error)}`, [
    { value: 'retry', name: 'Try again' },
    { value: 'skip', name: 'Skip this step' },
    { value: 'abort', name: 'Abort setup' },
  ]);
}

// ── Navigation prompts ──

export async function promptContinue(): Promise<void> {
  await promptConfirm('Continue?', { default: true });
}

export async function promptReconfigure(): Promise<boolean> {
  return promptConfirm('Already configured. Would you like to reconfigure?', {
    default: false,
  });
}

// ── Agent-specific prompts ──

export async function promptAgentModel(
  agentType: string,
  agentDescription: string,
  models: string[],
  currentModel?: string
): Promise<string> {
  const displayName =
    {
      research: 'Research',
      analyze: 'Analysis',
      write: 'Writing',
      code: 'Code',
      file: 'File Operations',
    }[agentType] ?? agentType;

  const message = `Select model for ${chalk.cyan(displayName)} agent ${chalk.dim(`(${agentDescription})`)}`;

  const choices: SelectOption[] = models.map((model) => ({
    value: model,
    name: model === currentModel ? `${model} ${chalk.dim('(current)')}` : model,
  }));

  // Add "Use orchestrator default" option
  choices.unshift({
    value: 'default',
    name: chalk.dim('Use orchestrator default model'),
    description: 'Inherit from the default orchestrator model',
  });

  const selection = await promptSelect(message, choices);

  return selection;
}
