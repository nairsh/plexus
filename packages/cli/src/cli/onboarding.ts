/**
 * Onboarding command - interactive first-time setup.
 */

import { resolve } from 'node:path';
import chalk from 'chalk';
import { config } from 'dotenv';
import {
  printBanner,
  printHeader,
  printSubHeader,
  printSuccess,
  printWarning,
  printError,
  printInfo,
  colors,
  icons,
  createSpinner,
} from '../ui/components.js';
import { setEnvVar, setEnvVars, envFileExists, ENV_KEYS } from '../lib/env-manager.js';
import { testLiteLLMConnection, testTavilyConnection } from '../lib/connection-tester.js';
import {
  isOnboardingComplete,
  completeOnboarding,
  resetOnboarding,
  getModelConfig,
  saveModelConfig,
  getDefaultModelConfig,
  updateOrchestratorModels,
  updateAgentModels,
  normalizeModelId,
  validateAndNormalizeModels,
} from '../lib/config-manager.js';
import { discoverAvailableModels, replaceModelRegistry } from '@orchestrator/model-router';
import {
  promptText,
  promptUrl,
  promptApiKey,
  promptConfirm,
  promptSelect,
  promptModels,
  promptModel,
  promptRetry,
  promptReconfigure,
  promptAgentModel,
} from '../lib/prompts.js';

// ── Types ──

interface OnboardingOptions {
  nonInteractive?: boolean;
  skipModels?: boolean;
}

interface OnboardingState {
  litellmUrl?: string;
  litellmApiKey?: string;
  tavilyApiKey?: string;
  orchestratorModels?: string[];
  defaultModel?: string;
  agentModels?: Record<string, string>;
}

// ── Main command ──

export async function runOnboarding(options: OnboardingOptions = {}): Promise<void> {
  printBanner();

  // Check if already configured
  if (isOnboardingComplete() && !options.nonInteractive) {
    const reconfigure = await promptReconfigure();
    if (!reconfigure) {
      printInfo('Onboarding cancelled. Current configuration preserved.');
      return;
    }
    resetOnboarding();
  }

  const state: OnboardingState = {};

  // Step 1: Welcome
  printHeader('Welcome to Orchestrator');
  console.log(chalk.white('This wizard will help you configure your orchestrator platform.'));
  console.log(chalk.dim('You can skip any step and configure later.\n'));

  // Step 2: Configure LiteLLM
  if (!options.skipModels) {
    await configureLiteLLM(state, options);
  }

  // Step 3: Configure Tavily (optional)
  await configureTavily(state, options);

  // Step 4: Fetch and assign models
  if (!options.skipModels && state.litellmUrl && state.litellmApiKey) {
    await configureModels(state, options);
  }

  // Step 5: Save configuration
  await saveConfiguration(state, options);

  // Step 6: Run doctor
  printHeader('Verifying Configuration');
  const { runDoctor } = await import('./doctor.js');
  await runDoctor({ verbose: false });

  // Mark complete
  completeOnboarding({ skipModelConfig: options.skipModels });

  printHeader('Setup Complete');
  printSuccess('Your orchestrator platform is ready to use!');
  console.log(chalk.dim('\nTry: orchestrator "What is the weather in San Francisco?"'));
}

// ── LiteLLM Configuration ──

async function configureLiteLLM(state: OnboardingState, options: OnboardingOptions): Promise<void> {
  printSubHeader('Step 1: Configure LiteLLM');
  console.log(chalk.dim('LiteLLM provides a unified API for multiple LLM providers.\n'));

  // Load existing .env if present
  if (envFileExists('.env')) {
    config({ path: resolve('.env') });
  }

  const defaultUrl = process.env.LITELLM_BASE_URL ?? 'http://localhost:4000';

  // Non-interactive mode
  if (options.nonInteractive) {
    state.litellmUrl = defaultUrl;
    state.litellmApiKey = process.env.LITELLM_API_KEY ?? '';
    printInfo(`Using LITELLM_BASE_URL: ${state.litellmUrl}`);
    return;
  }

  // Interactive mode
  let retries = 3;

  while (retries > 0) {
    // Get URL
    const url = await promptUrl('LiteLLM base URL', { default: defaultUrl });

    // Get API key
    const apiKey = await promptApiKey('LiteLLM API key (masked)', { required: false });

    // Test connection
    const spinner = createSpinner('Testing LiteLLM connection...').start();
    const result = await testLiteLLMConnection(url, apiKey);

    if (result.success) {
      spinner.succeed(chalk.green(`Connected to LiteLLM (${result.latency}ms)`));
      state.litellmUrl = url;
      state.litellmApiKey = apiKey;
      return;
    }

    spinner.fail(chalk.red(result.error));

    if (result.hint) {
      console.log(chalk.dim(`  Hint: ${result.hint}`));
    }

    retries--;

    if (retries > 0) {
      const action = await promptRetry('Connection failed.', result.error ?? '');

      if (action === 'skip') {
        printWarning('Skipping LiteLLM configuration.');
        state.litellmUrl = url;
        state.litellmApiKey = apiKey;
        return;
      }

      if (action === 'abort') {
        printError('Onboarding aborted.');
        process.exit(1);
      }
    } else {
      printWarning('Maximum retries reached. Saving configuration anyway.');
      state.litellmUrl = url;
      state.litellmApiKey = apiKey;
    }
  }
}

// ── Tavily Configuration ──

async function configureTavily(state: OnboardingState, options: OnboardingOptions): Promise<void> {
  printSubHeader('Step 2: Configure Tavily (Optional)');
  console.log(chalk.dim('Tavily provides web search capabilities.\n'));

  // Non-interactive mode
  if (options.nonInteractive) {
    state.tavilyApiKey = process.env.TAVILY_API_KEY ?? '';
    return;
  }

  // Ask if user wants to configure Tavily
  const configure = await promptConfirm('Configure Tavily API key?', { default: false });

  if (!configure) {
    printInfo('Skipping Tavily configuration. Web search will use public fallback.');
    return;
  }

  const apiKey = await promptApiKey('Tavily API key (masked)', { required: false });

  if (!apiKey) {
    printInfo('No API key provided. Skipping Tavily configuration.');
    return;
  }

  // Test connection
  const spinner = createSpinner('Testing Tavily connection...').start();
  const result = await testTavilyConnection(apiKey);

  if (result.success) {
    spinner.succeed(chalk.green(`Connected to Tavily (${result.latency}ms)`));
    state.tavilyApiKey = apiKey;
  } else {
    spinner.fail(chalk.yellow(result.error));
    printWarning('Tavily configuration saved, but connection test failed.');
    state.tavilyApiKey = apiKey;
  }
}

// ── Model Configuration ──

async function configureModels(state: OnboardingState, options: OnboardingOptions): Promise<void> {
  printSubHeader('Step 3: Configure Models');
  console.log(chalk.dim('Select which models to use for orchestrator and sub-agents.\n'));

  const hasConfiguredCredentials =
    Boolean(process.env.LITELLM_BASE_URL && process.env.LITELLM_API_KEY) ||
    Boolean(process.env.OPENAI_API_KEY) ||
    Boolean(process.env.ANTHROPIC_API_KEY) ||
    Boolean(process.env.GOOGLE_AI_API_KEY) ||
    Boolean(state.litellmUrl && state.litellmApiKey);

  if (!hasConfiguredCredentials) {
    printWarning('No model credentials configured. Using default model configuration.');
    return;
  }

  if (state.litellmUrl && state.litellmApiKey) {
    process.env.LITELLM_BASE_URL = state.litellmUrl;
    process.env.LITELLM_API_KEY = state.litellmApiKey;
  }

  // Fetch available models
  let availableModels: string[];

  const spinner = createSpinner('Fetching configured models...').start();

  try {
    const models = await discoverAvailableModels();
    spinner.succeed(chalk.green(`Found ${models.length} models`));

    if (models.length === 0) {
      printWarning('No models found from configured credentials. Using default configuration.');
      return;
    }

    replaceModelRegistry(models);

    // Normalize models to match registry format
    const normalizedModels = models.map((m) => normalizeModelId(m.id));
    const { valid, invalid, normalized } = validateAndNormalizeModels(normalizedModels);

    if (normalized.size > 0) {
      console.log(chalk.dim('\nNormalized model IDs:'));
      for (const [original, normalizedId] of normalized) {
        console.log(chalk.dim(`  ${original} → ${normalizedId}`));
      }
    }

    if (invalid.length > 0) {
      console.log(chalk.yellow(`\n⚠ Skipped ${invalid.length} unrecognized models:`));
      for (const model of invalid) {
        console.log(chalk.dim(`  • ${model}`));
      }
    }

    availableModels = valid;
  } catch (error) {
    spinner.fail(chalk.yellow('Could not fetch configured models'));
    printWarning('Using default model configuration.');
    return;
  }

  // Non-interactive mode
  if (options.nonInteractive) {
    state.orchestratorModels = availableModels.slice(0, 5);
    state.defaultModel = availableModels[0];
    return;
  }

  // Select orchestrator models
  console.log(chalk.white('\nSelect models to use for the orchestrator:'));

  const existingConfig = getModelConfig();
  const defaultModels = existingConfig?.orchestrator_models ?? availableModels.slice(0, 5);

  const selectedModels = await promptModels('Orchestrator models', availableModels, { default: defaultModels, min: 1 });

  state.orchestratorModels = selectedModels;

  // Select default model
  console.log(chalk.white('\nSelect the default model for the orchestrator:'));

  const defaultModel = await promptModel('Default orchestrator model', selectedModels, {
    default: existingConfig?.default_orchestrator_model,
  });

  state.defaultModel = defaultModel;

  // Configure agent models
  console.log(chalk.white('\nConfigure models for each sub-agent type:'));

  const agentConfigs: Record<string, string> = {};
  const agentDescriptions: Record<string, string> = {
    research: 'Web search and information gathering',
    analyze: 'Data analysis and synthesis',
    write: 'Content generation',
    code: 'Code writing and execution',
    file: 'File operations',
  };

  const existingAgentModels = existingConfig?.agent_models ?? {};

  for (const [agentType, description] of Object.entries(agentDescriptions)) {
    const typedAgentType = agentType as keyof typeof existingAgentModels;
    const currentModel = existingAgentModels[typedAgentType] ?? state.defaultModel;

    const useDefault = await promptConfirm(`Use default model for ${chalk.cyan(agentType)} agent? (${currentModel})`, {
      default: true,
    });

    if (useDefault) {
      agentConfigs[agentType] = state.defaultModel!;
    } else {
      const model = await promptModel(`Select model for ${agentType} agent`, selectedModels, { default: currentModel });
      agentConfigs[agentType] = model;
    }
  }

  state.agentModels = agentConfigs;
}

// ── Save Configuration ──

async function saveConfiguration(state: OnboardingState, options: OnboardingOptions): Promise<void> {
  printSubHeader('Step 4: Saving Configuration');

  const envPath = '.env';
  const envVars: Record<string, string> = {};

  // Save LiteLLM config
  if (state.litellmUrl) {
    envVars[ENV_KEYS.LITELLM_BASE_URL] = state.litellmUrl;
  }
  if (state.litellmApiKey) {
    envVars[ENV_KEYS.LITELLM_API_KEY] = state.litellmApiKey;
  }

  // Save Tavily config
  if (state.tavilyApiKey) {
    envVars[ENV_KEYS.TAVILY_API_KEY] = state.tavilyApiKey;
  }

  // Save to .env
  if (Object.keys(envVars).length > 0) {
    const spinner = createSpinner('Saving environment variables...').start();
    setEnvVars(envPath, envVars);
    spinner.succeed(chalk.green('Saved environment variables to .env'));
  }

  // Save model config
  if (state.orchestratorModels && state.orchestratorModels.length > 0) {
    const spinner = createSpinner('Saving model configuration...').start();

    const existingConfig = getModelConfig() ?? getDefaultModelConfig();

    const newConfig = {
      ...existingConfig,
      orchestrator_models: state.orchestratorModels,
      default_orchestrator_model: state.defaultModel ?? state.orchestratorModels[0],
      agent_models: state.agentModels ?? existingConfig.agent_models,
    };

    saveModelConfig(newConfig);
    spinner.succeed(chalk.green('Saved model configuration'));
  }

  printSuccess('Configuration saved!');
}
