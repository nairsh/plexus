/**
 * Config command - configuration management.
 */

import chalk from 'chalk';
import {
  printBanner,
  printHeader,
  printSubHeader,
  printSuccess,
  printError,
  printWarning,
  printConfigItem,
  printKeyValue,
  colors,
} from '../ui/components.js';
import { getConfigValue, setConfigValue, getModelConfig, ConfigKey } from '../lib/config-manager.js';
import { setEnvVar, ENV_KEYS } from '../lib/env-manager.js';

// ── Types ──

interface ConfigOptions {
  key?: string;
  value?: string;
}

// ── Main command ──

export async function runConfig(action: string, options: ConfigOptions = {}): Promise<void> {
  switch (action) {
    case 'list':
      await listConfig();
      break;
    case 'get':
      await getConfig(options.key!);
      break;
    case 'set':
      await setConfig(options.key!, options.value!);
      break;
    case 'reset':
      await resetConfig();
      break;
    default:
      printError(`Unknown action: ${action}`);
      console.log(chalk.dim('Usage: orchestrator config [list|get|set|reset]'));
      process.exit(1);
  }
}

// ── List config ──

async function listConfig(): Promise<void> {
  printBanner();
  printHeader('Current Configuration');

  // Environment variables
  printSubHeader('Environment Variables');

  const envVars = [
    { key: 'LITELLM_BASE_URL', configKey: 'litellm.baseUrl' as ConfigKey, sensitive: false },
    { key: 'LITELLM_API_KEY', configKey: 'litellm.apiKey' as ConfigKey, sensitive: true },
    { key: 'TAVILY_API_KEY', configKey: 'tavily.apiKey' as ConfigKey, sensitive: true },
  ];

  for (const { key, configKey, sensitive } of envVars) {
    const value = process.env[key];
    printConfigItem(key, value, { sensitive });
  }

  // Model configuration
  printSubHeader('Model Configuration');

  const modelConfig = getModelConfig();

  if (modelConfig) {
    // Default model
    printConfigItem('Default Model', modelConfig.default_orchestrator_model);

    // Orchestrator models
    const modelsList = modelConfig.orchestrator_models?.join(', ') ?? '(none)';
    console.log(`  ${colors.muted('•')} ${chalk.dim('Orchestrator Models')}: ${modelsList}`);

    // Agent models
    const agentModels = modelConfig.agent_models ?? {};
    console.log(chalk.dim('\n  Agent Model Assignments:'));

    const agentOrder = ['research', 'analyze', 'write', 'code', 'file'] as const;
    for (const agentType of agentOrder) {
      const model = agentModels[agentType];
      printConfigItem(`  ${agentType}`, model);
    }
  } else {
    printWarning('Model configuration not found. Run "orchestrator onboarding" to configure.');
  }

  console.log('');
}

// ── Get config ──

async function getConfig(key: string): Promise<void> {
  if (!key) {
    printError('Key is required');
    console.log(chalk.dim('Usage: orchestrator config get <key>'));
    process.exit(1);
  }

  // Map shorthand keys to config keys
  const keyMapping: Record<string, ConfigKey> = {
    'litellm.url': 'litellm.baseUrl',
    'litellm.baseUrl': 'litellm.baseUrl',
    'litellm.apiKey': 'litellm.apiKey',
    'tavily.apiKey': 'tavily.apiKey',
    'models.default': 'models.default',
    'models.orchestrator': 'models.orchestrator',
    research: 'models.research',
    analyze: 'models.analyze',
    write: 'models.write',
    code: 'models.code',
    file: 'models.file',
  };

  const configKey = keyMapping[key] ?? (key as ConfigKey);
  const value = getConfigValue(configKey);

  if (value !== undefined) {
    console.log(value);
  } else {
    printWarning(`Configuration key "${key}" not found or not set.`);
    process.exit(1);
  }
}

// ── Set config ──

async function setConfig(key: string, value: string): Promise<void> {
  if (!key || !value) {
    printError('Key and value are required');
    console.log(chalk.dim('Usage: orchestrator config set <key> <value>'));
    process.exit(1);
  }

  // Map shorthand keys
  const keyMapping: Record<string, ConfigKey | 'env'> = {
    'litellm.url': 'env',
    'litellm.baseUrl': 'env',
    'litellm.apiKey': 'env',
    'tavily.apiKey': 'env',
    'models.default': 'models.default',
    'models.orchestrator': 'models.orchestrator',
    research: 'models.research',
    analyze: 'models.analyze',
    write: 'models.write',
    code: 'models.code',
    file: 'models.file',
  };

  const mappedKey = keyMapping[key];

  try {
    if (mappedKey === 'env') {
      // Set environment variable
      const envKeyMapping: Record<string, string> = {
        'litellm.url': ENV_KEYS.LITELLM_BASE_URL,
        'litellm.baseUrl': ENV_KEYS.LITELLM_BASE_URL,
        'litellm.apiKey': ENV_KEYS.LITELLM_API_KEY,
        'tavily.apiKey': ENV_KEYS.TAVILY_API_KEY,
      };

      const envKey = envKeyMapping[key];
      if (envKey) {
        setEnvVar('.env', envKey, value);
        printSuccess(`Set ${envKey} in .env`);
      }
    } else if (mappedKey) {
      setConfigValue(mappedKey, value);
      printSuccess(`Set ${key} to ${value}`);
    } else {
      printError(`Unknown configuration key: ${key}`);
      console.log(chalk.dim('\nAvailable keys:'));
      console.log(chalk.dim('  litellm.url, litellm.apiKey'));
      console.log(chalk.dim('  tavily.apiKey'));
      console.log(chalk.dim('  models.default, models.orchestrator'));
      console.log(chalk.dim('  research, analyze, write, code, file'));
      process.exit(1);
    }
  } catch (error) {
    printError((error as Error).message);
    process.exit(1);
  }
}

// ── Reset config ──

async function resetConfig(): Promise<void> {
  const { promptConfirm } = await import('../lib/prompts.js');

  const confirm = await promptConfirm('Reset all configuration to defaults? This cannot be undone.', {
    default: false,
  });

  if (!confirm) {
    console.log(chalk.dim('Reset cancelled.'));
    return;
  }

  // Reset .env
  const { createEnvTemplate } = await import('../lib/env-manager.js');
  createEnvTemplate('.env', {
    LITELLM_BASE_URL: 'http://localhost:4000',
    LITELLM_API_KEY: '',
    TAVILY_API_KEY: '',
    DATABASE_PATH: './data/orchestrator.db',
  });

  // Reset model config
  const { saveModelConfig, getDefaultModelConfig, resetOnboarding } = await import('../lib/config-manager.js');
  saveModelConfig(getDefaultModelConfig());
  resetOnboarding();

  printSuccess('Configuration reset to defaults.');
  console.log(chalk.dim('Run "orchestrator onboarding" to reconfigure.'));
}

// ── Help ──

export function printConfigHelp(): void {
  console.log(chalk.bold('\nConfig Command Usage\n'));
  console.log('  orchestrator config list           Show all configuration');
  console.log('  orchestrator config get <key>      Get a specific value');
  console.log('  orchestrator config set <key> <value>  Set a value');
  console.log('  orchestrator config reset          Reset to defaults');
  console.log('');
  console.log(chalk.dim('Keys:'));
  console.log(chalk.dim('  litellm.url        LiteLLM base URL'));
  console.log(chalk.dim('  litellm.apiKey     LiteLLM API key'));
  console.log(chalk.dim('  tavily.apiKey      Tavily API key'));
  console.log(chalk.dim('  models.default     Default orchestrator model'));
  console.log(chalk.dim('  models.orchestrator  Allowed orchestrator models'));
  console.log(chalk.dim('  research, analyze, write, code, file  Agent model assignments'));
  console.log('');
}
