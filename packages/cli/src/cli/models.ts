/**
 * Models command - model management.
 */

import chalk from 'chalk';
import { config } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  printBanner,
  printHeader,
  printSubHeader,
  printSuccess,
  printError,
  printWarning,
  printModelItem,
  printAgentBadge,
  colors,
  icons,
  createSpinner,
} from '../ui/components.js';
import {
  getModelConfig,
  updateOrchestratorModels,
  setAgentModel,
  getAllAgentModels,
  normalizeModelId,
  validateAndNormalizeModels,
  tryNormalizeModelId,
} from '../lib/config-manager.js';
import { discoverAvailableModels, replaceModelRegistry } from '@orchestrator/model-router';

// ── Types ──

interface ModelsOptions {
  agent?: string;
  model?: string;
}

// ── Main command ──

export async function runModels(action: string, options: ModelsOptions = {}): Promise<void> {
  switch (action) {
    case 'list':
      await listModels();
      break;
    case 'fetch':
      await fetchModels();
      break;
    case 'assign':
      await assignModel(options.agent!, options.model!);
      break;
    case 'default':
      await setDefaultModel(options.model!);
      break;
    default:
      printError(`Unknown action: ${action}`);
      console.log(chalk.dim('Usage: orchestrator models [list|fetch|assign|default]'));
      process.exit(1);
  }
}

// ── List models ──

async function listModels(): Promise<void> {
  printBanner();
  printHeader('Available Models');

  const modelConfig = getModelConfig();

  if (!modelConfig) {
    printWarning('Model configuration not found. Run "orchestrator onboarding" to configure.');
    return;
  }

  // Orchestrator models
  printSubHeader('Orchestrator Models (allowed)');

  const orchestratorModels = modelConfig.orchestrator_models ?? [];
  const defaultModel = modelConfig.default_orchestrator_model;

  if (orchestratorModels.length === 0) {
    printWarning('No orchestrator models configured.');
  } else {
    for (const model of orchestratorModels) {
      printModelItem(model, { isDefault: model === defaultModel });
    }
  }

  // Agent model assignments
  printSubHeader('Agent Model Assignments');

  const agentModels = getAllAgentModels();
  const agentOrder = ['research', 'analyze', 'write', 'code', 'file'] as const;

  for (const agentType of agentOrder) {
    const model = agentModels[agentType];
    const badge = printAgentBadge(agentType);

    if (model) {
      console.log(`  ${badge} ${chalk.dim('→')} ${chalk.white(model)}`);
    } else {
      console.log(`  ${badge} ${chalk.dim('→')} ${chalk.dim('(using default)')}`);
    }
  }

  console.log('');
}

// ── Fetch models from LiteLLM ──

async function fetchModels(): Promise<void> {
  printBanner();
  printHeader('Fetch Configured Models');

  if (existsSync(resolve('.env'))) {
    config({ path: resolve('.env') });
  }

  const fetchSpinner = createSpinner('Discovering configured models...').start();

  try {
    const models = await discoverAvailableModels();
    fetchSpinner.succeed(chalk.green(`Found ${models.length} models`));

    if (models.length === 0) {
      printWarning('No models found from configured credentials.');
      return;
    }

    replaceModelRegistry(models);

    // Display models
    printSubHeader('Available Models');

    for (const model of models) {
      console.log(`  ${colors.muted('•')} ${chalk.white(model.id)}`);
    }

    // Ask to update orchestrator models
    const { promptConfirm } = await import('../lib/prompts.js');
    const update = await promptConfirm('\nUpdate orchestrator models with these models?', { default: true });

    if (update) {
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

      if (valid.length === 0) {
        printError('No valid models found to add.');
        return;
      }

      // Ask to set default
      const defaultModel = await (
        await import('../lib/prompts.js')
      ).promptModel('Select default model', valid.slice(0, 10), {});

      updateOrchestratorModels(valid, defaultModel);
      printSuccess(`Updated orchestrator models with ${valid.length} models.`);
      printSuccess(`Default model set to ${defaultModel}`);
    }
  } catch (error) {
    fetchSpinner.fail(chalk.red((error as Error).message));
    process.exit(1);
  }
}

// ── Assign model to agent ──

async function assignModel(agent: string, model: string): Promise<void> {
  if (!agent || !model) {
    printError('Agent and model are required');
    console.log(chalk.dim('Usage: orchestrator models assign <agent> <model>'));
    console.log(chalk.dim('Agents: research, analyze, write, code, file'));
    process.exit(1);
  }

  const validAgents = ['research', 'analyze', 'write', 'code', 'file'];

  if (!validAgents.includes(agent)) {
    printError(`Invalid agent: ${agent}`);
    console.log(chalk.dim(`Valid agents: ${validAgents.join(', ')}`));
    process.exit(1);
  }

  // Normalize the input model ID
  const normalizedModel = tryNormalizeModelId(model) || model;

  // Validate model is in allowed list
  const modelConfig = getModelConfig();

  if (modelConfig && !modelConfig.orchestrator_models.includes(normalizedModel)) {
    printWarning(`Model ${normalizedModel} is not in the allowed orchestrator models list.`);
    console.log(chalk.dim('Available models:'));
    for (const m of modelConfig.orchestrator_models) {
      console.log(chalk.dim(`  ${m}`));
    }

    const { promptConfirm } = await import('../lib/prompts.js');
    const proceed = await promptConfirm('Assign anyway?', { default: false });

    if (!proceed) {
      console.log(chalk.dim('Assignment cancelled.'));
      return;
    }
  }

  setAgentModel(agent, normalizedModel);
  printSuccess(`Assigned ${chalk.cyan(normalizedModel)} to ${printAgentBadge(agent)}`);
}

// ── Set default model ──

async function setDefaultModel(model: string): Promise<void> {
  if (!model) {
    printError('Model is required');
    console.log(chalk.dim('Usage: orchestrator models default <model>'));
    process.exit(1);
  }

  const modelConfig = getModelConfig();

  if (!modelConfig) {
    printError('Model configuration not found. Run "orchestrator onboarding" first.');
    process.exit(1);
  }

  // Normalize the input model ID
  const normalizedModel = tryNormalizeModelId(model) || model;

  if (!modelConfig.orchestrator_models.includes(normalizedModel)) {
    printError(`Model ${normalizedModel} is not in the allowed orchestrator models list.`);
    console.log(chalk.dim('Available models:'));
    for (const m of modelConfig.orchestrator_models) {
      console.log(chalk.dim(`  ${m}`));
    }
    process.exit(1);
  }

  updateOrchestratorModels(modelConfig.orchestrator_models, normalizedModel);
  printSuccess(`Default orchestrator model set to ${chalk.cyan(normalizedModel)}`);
}

// ── Help ──

export function printModelsHelp(): void {
  console.log(chalk.bold('\nModels Command Usage\n'));
  console.log('  orchestrator models list              List configured models');
  console.log('  orchestrator models fetch             Fetch models from LiteLLM');
  console.log('  orchestrator models assign <agent> <model>  Assign model to agent');
  console.log('  orchestrator models default <model>   Set default orchestrator model');
  console.log('');
  console.log(chalk.dim('Agents: research, analyze, write, code, file'));
  console.log('');
}
