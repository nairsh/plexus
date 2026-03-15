#!/usr/bin/env node
/**
 * Interactive Configure CLI
 *
 * A menu-driven configuration tool for the orchestrator platform.
 */

import { config } from 'dotenv';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

// Load .env file if it exists
if (existsSync(resolve('.env'))) {
  config({ path: resolve('.env') });
}

import chalk from 'chalk';
import { select, confirm, input, password } from '@inquirer/prompts';
import {
  printBanner,
  printHeader,
  printSuccess,
  printError,
  printWarning,
  printInfo,
  colors,
  createSpinner,
} from '../ui/components.js';
import { setEnvVar, ENV_KEYS } from '../lib/env-manager.js';
import { testLiteLLMConnection, testTavilyConnection } from '../lib/connection-tester.js';
import {
  getModelConfig,
  saveModelConfig,
  getDefaultModelConfig,
  updateOrchestratorModels,
  setAgentModel,
  getAllAgentModels,
} from '../lib/config-manager.js';

// ── Main menu ──

async function mainMenu(): Promise<void> {
  while (true) {
    console.log('');
    const action = await select({
      message: chalk.bold('What would you like to configure?'),
      choices: [
        { value: 'litellm', name: '🔗 LiteLLM Connection', description: 'Configure LiteLLM proxy URL and API key' },
        { value: 'tavily', name: '🔍 Tavily Search', description: 'Configure Tavily API key for web search' },
        { value: 'models', name: '🤖 Models', description: 'Configure orchestrator and agent models' },
        { value: 'status', name: '📊 Show Status', description: 'Display current configuration' },
        { value: 'test', name: '🧪 Test Connections', description: 'Test LiteLLM and Tavily connections' },
        { value: 'exit', name: '👋 Exit', description: 'Save and exit' },
      ],
    });

    switch (action) {
      case 'litellm':
        await configureLiteLLM();
        break;
      case 'tavily':
        await configureTavily();
        break;
      case 'models':
        await configureModels();
        break;
      case 'status':
        await showStatus();
        break;
      case 'test':
        await testConnections();
        break;
      case 'exit':
        console.log('');
        printSuccess('Configuration saved. Goodbye!');
        return;
    }
  }
}

// ── LiteLLM Configuration ──

async function configureLiteLLM(): Promise<void> {
  printHeader('LiteLLM Configuration');

  const currentUrl = process.env.LITELLM_BASE_URL ?? '';
  const currentKey = process.env.LITELLM_API_KEY ?? '';

  console.log(chalk.dim(`Current URL: ${currentUrl || '(not set)'}`));
  console.log(chalk.dim(`Current Key: ${currentKey ? '*'.repeat(8) : '(not set)'}`));
  console.log('');

  // URL
  const newUrl = await input({
    message: 'LiteLLM base URL',
    default: currentUrl || 'http://localhost:4000',
    validate: (value) => {
      try {
        new URL(value);
        return true;
      } catch {
        return 'Please enter a valid URL';
      }
    },
  });

  // API Key
  const newKey = await password({
    message: 'LiteLLM API key (leave empty to skip)',
  });

  // Test connection
  if (newKey) {
    const testNow = await confirm({
      message: 'Test connection now?',
      default: true,
    });

    if (testNow) {
      const spinner = createSpinner('Testing connection...').start();
      const result = await testLiteLLMConnection(newUrl, newKey);

      if (result.success) {
        spinner.succeed(chalk.green(`Connected! (${result.latency}ms)`));
        if (result.data && Array.isArray(result.data)) {
          console.log(chalk.dim(`  Found ${(result.data as string[]).length} models`));
        }
      } else {
        spinner.fail(chalk.red(result.error));
        if (result.hint) {
          console.log(chalk.dim(`  Hint: ${result.hint}`));
        }

        const proceed = await confirm({
          message: 'Save anyway?',
          default: false,
        });

        if (!proceed) {
          printWarning('Configuration not saved.');
          return;
        }
      }
    }
  }

  // Save
  setEnvVar('.env', ENV_KEYS.LITELLM_BASE_URL, newUrl);
  if (newKey) {
    setEnvVar('.env', ENV_KEYS.LITELLM_API_KEY, newKey);
  }

  // Update process.env for current session
  process.env.LITELLM_BASE_URL = newUrl;
  if (newKey) {
    process.env.LITELLM_API_KEY = newKey;
  }

  printSuccess('LiteLLM configuration saved!');
}

// ── Tavily Configuration ──

async function configureTavily(): Promise<void> {
  printHeader('Tavily Search Configuration');

  const currentKey = process.env.TAVILY_API_KEY ?? '';

  console.log(chalk.dim(`Current Key: ${currentKey ? '*'.repeat(8) : '(not set)'}`));
  console.log(chalk.dim('\nTavily provides web search capabilities. It\'s optional - the system will use a public fallback if not configured.'));
  console.log('');

  const newKey = await password({
    message: 'Tavily API key (leave empty to remove)',
  });

  if (newKey) {
    // Test connection
    const testNow = await confirm({
      message: 'Test connection now?',
      default: true,
    });

    if (testNow) {
      const spinner = createSpinner('Testing Tavily connection...').start();
      const result = await testTavilyConnection(newKey);

      if (result.success) {
        spinner.succeed(chalk.green(`Connected! (${result.latency}ms)`));
      } else {
        spinner.fail(chalk.yellow(result.error));
        console.log(chalk.dim('  Configuration will be saved, but web search may not work.'));
      }
    }

    setEnvVar('.env', ENV_KEYS.TAVILY_API_KEY, newKey);
    process.env.TAVILY_API_KEY = newKey;
    printSuccess('Tavily API key saved!');
  } else if (currentKey) {
    const remove = await confirm({
      message: 'Remove Tavily API key?',
      default: false,
    });

    if (remove) {
      setEnvVar('.env', ENV_KEYS.TAVILY_API_KEY, '');
      delete process.env.TAVILY_API_KEY;
      printInfo('Tavily API key removed.');
    }
  } else {
    printInfo('No changes made.');
  }
}

// ── Models Configuration ──

async function configureModels(): Promise<void> {
  printHeader('Model Configuration');

  const modelConfig = getModelConfig() ?? getDefaultModelConfig();

  while (true) {
    console.log('');
    const action = await select({
      message: chalk.bold('Model Configuration'),
      choices: [
        { value: 'default', name: '🎯 Default Model', description: `Current: ${modelConfig.default_orchestrator_model}` },
        { value: 'allowed', name: '📋 Allowed Models', description: `Manage the list of allowed orchestrator models` },
        { value: 'agents', name: '🤖 Agent Models', description: 'Configure model for each agent type' },
        { value: 'fetch', name: '⬇️ Fetch from LiteLLM', description: 'Fetch available models from LiteLLM' },
        { value: 'back', name: '← Back to main menu', description: '' },
      ],
    });

    switch (action) {
      case 'default':
        await configureDefaultModel();
        break;
      case 'allowed':
        await configureAllowedModels();
        break;
      case 'agents':
        await configureAgentModels();
        break;
      case 'fetch':
        await fetchModelsFromLiteLLM();
        break;
      case 'back':
        return;
    }
  }
}

async function configureDefaultModel(): Promise<void> {
  const modelConfig = getModelConfig();
  if (!modelConfig) {
    printWarning('No model configuration found. Please run onboarding first.');
    return;
  }

  const choices = modelConfig.orchestrator_models.map((model) => ({
    value: model,
    name: model === modelConfig.default_orchestrator_model ? `${model} (current)` : model,
  }));

  const newDefault = await select({
    message: 'Select default orchestrator model',
    choices,
  });

  updateOrchestratorModels(modelConfig.orchestrator_models, newDefault);
  printSuccess(`Default model set to ${newDefault}`);
}

async function configureAllowedModels(): Promise<void> {
  const modelConfig = getModelConfig();
  if (!modelConfig) {
    printWarning('No model configuration found.');
    return;
  }

  console.log(chalk.dim('\nCurrent allowed models:'));
  for (const model of modelConfig.orchestrator_models) {
    const isDefault = model === modelConfig.default_orchestrator_model;
    console.log(`  ${isDefault ? '✓' : '•'} ${model}`);
  }
  console.log('');

  const action = await select({
    message: 'Manage allowed models',
    choices: [
      { value: 'add', name: '➕ Add model', description: 'Add a new model to the list' },
      { value: 'remove', name: '➖ Remove model', description: 'Remove a model from the list' },
      { value: 'back', name: '← Back', description: '' },
    ],
  });

  if (action === 'add') {
    const newModel = await input({
      message: 'Enter model ID (e.g., litellm/gpt-4)',
      validate: (value) => value.includes('/') ? true : 'Model ID should be in format: provider/model',
    });

    if (!modelConfig.orchestrator_models.includes(newModel)) {
      updateOrchestratorModels([...modelConfig.orchestrator_models, newModel], modelConfig.default_orchestrator_model);
      printSuccess(`Added ${newModel} to allowed models`);
    } else {
      printWarning('Model already in list');
    }
  } else if (action === 'remove') {
    const toRemove = await select({
      message: 'Select model to remove',
      choices: modelConfig.orchestrator_models
        .filter((m) => m !== modelConfig.default_orchestrator_model)
        .map((model) => ({ value: model, name: model })),
    });

    const newModels = modelConfig.orchestrator_models.filter((m) => m !== toRemove);
    updateOrchestratorModels(newModels, modelConfig.default_orchestrator_model);
    printSuccess(`Removed ${toRemove}`);
  }
}

async function configureAgentModels(): Promise<void> {
  const modelConfig = getModelConfig();
  if (!modelConfig) {
    printWarning('No model configuration found.');
    return;
  }

  const agentTypes = ['research', 'analyze', 'write', 'code', 'file'] as const;
  const agentDescriptions: Record<string, string> = {
    research: 'Web search and information gathering',
    analyze: 'Data analysis and synthesis',
    write: 'Content generation',
    code: 'Code writing and execution',
    file: 'File operations',
  };

  const currentModels = getAllAgentModels();

  console.log(chalk.dim('\nCurrent agent model assignments:'));
  for (const agent of agentTypes) {
    const model = currentModels[agent] ?? modelConfig.default_orchestrator_model;
    console.log(`  ${agent.padEnd(10)} → ${model}`);
  }
  console.log('');

  const agent = await select({
    message: 'Select agent to configure',
    choices: [
      ...agentTypes.map((a) => ({
        value: a,
        name: `${a.padEnd(10)} (${agentDescriptions[a]})`,
      })),
      { value: 'all', name: 'Set same model for all agents' },
      { value: 'back', name: '← Back' },
    ],
  });

  if (agent === 'back') {
    return;
  }

  const choices = modelConfig.orchestrator_models.map((model) => ({
    value: model,
    name: model,
  }));

  // Add "use default" option
  choices.unshift({
    value: 'default',
    name: chalk.dim('(use default orchestrator model)'),
  });

  const newModel = await select({
    message: `Select model for ${agent === 'all' ? 'all agents' : agent}`,
    choices,
  });

  if (agent === 'all') {
    for (const a of agentTypes) {
      if (newModel === 'default') {
        setAgentModel(a, modelConfig.default_orchestrator_model);
      } else {
        setAgentModel(a, newModel);
      }
    }
    printSuccess(`All agents set to use ${newModel === 'default' ? 'default model' : newModel}`);
  } else {
    if (newModel === 'default') {
      setAgentModel(agent, modelConfig.default_orchestrator_model);
    } else {
      setAgentModel(agent, newModel);
    }
    printSuccess(`${agent} agent set to use ${newModel === 'default' ? 'default model' : newModel}`);
  }
}

async function fetchModelsFromLiteLLM(): Promise<void> {
  const litellmUrl = process.env.LITELLM_BASE_URL;
  const litellmKey = process.env.LITELLM_API_KEY;

  if (!litellmUrl || !litellmKey) {
    printError('LiteLLM not configured. Please configure LiteLLM first.');
    return;
  }

  const spinner = createSpinner('Fetching models from LiteLLM...').start();

  try {
    const { fetchLiteLLMModels } = await import('../lib/connection-tester.js');
    const models = await fetchLiteLLMModels(litellmUrl, litellmKey);
    spinner.succeed(chalk.green(`Found ${models.length} models`));

    if (models.length === 0) {
      printWarning('No models found on LiteLLM instance.');
      return;
    }

    console.log(chalk.dim('\nAvailable models:'));
    for (const model of models.slice(0, 20)) {
      console.log(`  • litellm/${model}`);
    }
    if (models.length > 20) {
      console.log(chalk.dim(`  ... and ${models.length - 20} more`));
    }

    const update = await confirm({
      message: 'Update allowed models with these?',
      default: true,
    });

    if (update) {
      const litellmModels = models.map((m) => `litellm/${m}`);
      updateOrchestratorModels(litellmModels);
      printSuccess(`Updated allowed models with ${models.length} models`);
    }
  } catch (error) {
    spinner.fail(chalk.red((error as Error).message));
  }
}

// ── Show Status ──

async function showStatus(): Promise<void> {
  printHeader('Current Configuration');

  console.log(chalk.bold('\nEnvironment:'));
  console.log(`  LITELLM_BASE_URL: ${process.env.LITELLM_BASE_URL ?? chalk.dim('(not set)')}`);
  console.log(`  LITELLM_API_KEY: ${process.env.LITELLM_API_KEY ? '*'.repeat(8) : chalk.dim('(not set)')}`);
  console.log(`  TAVILY_API_KEY: ${process.env.TAVILY_API_KEY ? '*'.repeat(8) : chalk.dim('(not set)')}`);

  const modelConfig = getModelConfig();
  if (modelConfig) {
    console.log(chalk.bold('\nModels:'));
    console.log(`  Default: ${modelConfig.default_orchestrator_model}`);
    console.log(`  Allowed: ${modelConfig.orchestrator_models.length} models`);

    const agentModels = getAllAgentModels();
    console.log(chalk.bold('\nAgent Assignments:'));
    for (const [agent, model] of Object.entries(agentModels)) {
      console.log(`  ${agent.padEnd(10)} → ${model}`);
    }
  }

  console.log('');
  await confirm({ message: 'Press Enter to continue', default: true });
}

// ── Test Connections ──

async function testConnections(): Promise<void> {
  printHeader('Test Connections');

  const results: { name: string; status: 'success' | 'error' | 'warning'; message: string }[] = [];

  // Test LiteLLM
  const litellmUrl = process.env.LITELLM_BASE_URL;
  const litellmKey = process.env.LITELLM_API_KEY;

  if (litellmUrl && litellmKey) {
    const spinner = createSpinner('Testing LiteLLM...').start();
    const result = await testLiteLLMConnection(litellmUrl, litellmKey);

    if (result.success) {
      spinner.succeed(chalk.green(`LiteLLM: Connected (${result.latency}ms)`));
      results.push({ name: 'LiteLLM', status: 'success', message: `${result.latency}ms` });
    } else {
      spinner.fail(chalk.red(`LiteLLM: ${result.error}`));
      results.push({ name: 'LiteLLM', status: 'error', message: result.error ?? 'Failed' });
    }
  } else {
    console.log(chalk.yellow('⚠ LiteLLM: Not configured'));
    results.push({ name: 'LiteLLM', status: 'warning', message: 'Not configured' });
  }

  // Test Tavily
  const tavilyKey = process.env.TAVILY_API_KEY;

  if (tavilyKey) {
    const spinner = createSpinner('Testing Tavily...').start();
    const result = await testTavilyConnection(tavilyKey);

    if (result.success) {
      spinner.succeed(chalk.green(`Tavily: Connected (${result.latency}ms)`));
      results.push({ name: 'Tavily', status: 'success', message: `${result.latency}ms` });
    } else {
      spinner.fail(chalk.yellow(`Tavily: ${result.error}`));
      results.push({ name: 'Tavily', status: 'warning', message: result.error ?? 'Failed' });
    }
  } else {
    console.log(chalk.yellow('⚠ Tavily: Not configured (optional)'));
    results.push({ name: 'Tavily', status: 'warning', message: 'Not configured (optional)' });
  }

  console.log('');
  await confirm({ message: 'Press Enter to continue', default: true });
}

// ── Main ──

export async function runConfigure(): Promise<void> {
  printBanner();
  console.log(chalk.white('Welcome to the Orchestrator Configuration Tool'));
  console.log(chalk.dim('Use the menu below to configure your setup.\n'));

  await mainMenu();
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runConfigure().catch((error) => {
    console.error(chalk.red('\nError:'), error.message);
    process.exit(1);
  });
}