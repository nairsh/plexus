/**
 * Doctor command - health check and diagnostics.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import chalk from 'chalk';
import { config } from 'dotenv';
import { printBanner, printHeader, printCategory, printSummary, icons, colors } from '../ui/components.js';
import { envFileExists } from '../lib/env-manager.js';
import { testLiteLLMConnection, testTavilyConnection, testDatabaseConnection } from '../lib/connection-tester.js';
import {
  getModelConfig,
  isOnboardingComplete,
  validateAndNormalizeModels,
  tryNormalizeModelId,
  updateOrchestratorModels,
  setAgentModel,
} from '../lib/config-manager.js';

// ── Types ──

interface CheckResult {
  category: string;
  name: string;
  status: 'success' | 'warning' | 'error';
  message?: string;
  hint?: string;
  details?: string;
}

interface DoctorOptions {
  verbose?: boolean;
  fix?: boolean;
}

// ── Main command ──

export async function runDoctor(options: DoctorOptions = {}): Promise<void> {
  printBanner();
  printHeader('Doctor Check Results');

  const results: CheckResult[] = [];

  // Environment checks
  results.push(...(await checkEnvironment(options)));

  // Connection checks
  results.push(...(await checkConnections(options)));

  // Model config checks
  results.push(...(await checkModelConfig(options)));

  // Print results
  printResults(results, options);

  // Summary
  const passed = results.filter((r) => r.status === 'success').length;
  const warnings = results.filter((r) => r.status === 'warning').length;
  const failures = results.filter((r) => r.status === 'error').length;

  printSummary(passed, warnings, failures);

  // Exit code
  if (failures > 0) {
    process.exit(1);
  }
}

// ── Environment checks ──

async function checkEnvironment(_options: DoctorOptions): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const envPath = '.env';

  // Load .env if exists
  if (existsSync(resolve(envPath))) {
    config({ path: resolve(envPath) });
  }

  printCategory('Environment');

  // .env file exists
  results.push({
    category: 'Environment',
    name: '.env file',
    status: envFileExists(envPath) ? 'success' : 'warning',
    message: envFileExists(envPath) ? undefined : 'Not found (will use defaults)',
    hint: envFileExists(envPath) ? undefined : 'Run "orchestrator onboarding" to create one',
  });

  // LITELLM_BASE_URL
  const litellmUrl = process.env.LITELLM_BASE_URL;
  results.push({
    category: 'Environment',
    name: 'LITELLM_BASE_URL',
    status: litellmUrl ? 'success' : 'warning',
    message: litellmUrl ? litellmUrl : 'Not configured',
    hint: litellmUrl ? undefined : 'Set LITELLM_BASE_URL to your LiteLLM instance URL',
  });

  // LITELLM_API_KEY
  const litellmKey = process.env.LITELLM_API_KEY;
  results.push({
    category: 'Environment',
    name: 'LITELLM_API_KEY',
    status: litellmKey ? 'success' : 'warning',
    message: litellmKey ? 'configured' : 'Not configured',
    hint: litellmKey ? undefined : 'Set LITELLM_API_KEY for LiteLLM authentication',
  });

  // Database
  const dbPath = process.env.DATABASE_PATH ?? './data/orchestrator.db';
  const dbResult = testDatabaseConnection(dbPath);
  results.push({
    category: 'Environment',
    name: 'Database',
    status: dbResult.success ? 'success' : 'error',
    message: dbResult.success ? dbPath : dbResult.error,
    hint: dbResult.hint,
  });

  // Database writable
  if (dbResult.success && existsSync(dbPath)) {
    const writeResult = testDatabaseConnection(dbPath);
    results.push({
      category: 'Environment',
      name: 'Database writable',
      status: writeResult.success ? 'success' : 'error',
      message: writeResult.success ? undefined : writeResult.error,
    });
  }

  // Onboarding status
  results.push({
    category: 'Environment',
    name: 'Onboarding',
    status: isOnboardingComplete() ? 'success' : 'warning',
    message: isOnboardingComplete() ? 'Completed' : 'Not completed',
    hint: isOnboardingComplete() ? undefined : 'Run "orchestrator onboarding" to configure',
  });

  return results;
}

// ── Connection checks ──

async function checkConnections(options: DoctorOptions): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  printCategory('Connections');

  // LiteLLM connection
  const litellmUrl = process.env.LITELLM_BASE_URL;
  const litellmKey = process.env.LITELLM_API_KEY;

  if (litellmUrl && litellmKey) {
    const result = await testLiteLLMConnection(litellmUrl, litellmKey);
    results.push({
      category: 'Connections',
      name: 'LiteLLM connection',
      status: result.success ? 'success' : 'error',
      message: result.success ? `${result.latency}ms` : result.error,
      hint: result.hint,
      details:
        options.verbose && result.success ? `${(result.data as string[])?.length ?? 0} models available` : undefined,
    });
  } else {
    results.push({
      category: 'Connections',
      name: 'LiteLLM connection',
      status: 'warning',
      message: 'Skipped (not configured)',
    });
  }

  // Tavily connection
  const tavilyKey = process.env.TAVILY_API_KEY;

  if (tavilyKey) {
    const result = await testTavilyConnection(tavilyKey);
    results.push({
      category: 'Connections',
      name: 'Tavily API',
      status: result.success ? 'success' : 'warning',
      message: result.success ? `${result.latency}ms` : result.error,
      hint: result.hint,
    });
  } else {
    results.push({
      category: 'Connections',
      name: 'Tavily API',
      status: 'warning',
      message: 'Not configured (web search will use public fallback)',
    });
  }

  return results;
}

// ── Model config checks ──

async function checkModelConfig(options: DoctorOptions): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  printCategory('Models');

  // model_config.json valid
  const modelConfig = getModelConfig();
  results.push({
    category: 'Models',
    name: 'model_config.json',
    status: modelConfig ? 'success' : 'error',
    message: modelConfig ? 'Valid' : 'Invalid or missing',
    hint: modelConfig ? undefined : 'Run "orchestrator onboarding" to generate',
  });

  if (!modelConfig) {
    return results;
  }

  // Orchestrator models available
  const orchestratorModels = modelConfig.orchestrator_models ?? [];
  results.push({
    category: 'Models',
    name: 'Orchestrator models',
    status: orchestratorModels.length > 0 ? 'success' : 'error',
    message: orchestratorModels.length > 0 ? `${orchestratorModels.length} models available` : 'No models configured',
  });

  // Check for model ID mismatches
  const { valid, invalid, normalized } = validateAndNormalizeModels(orchestratorModels);
  const hasMismatches = normalized.size > 0 || invalid.length > 0;

  if (hasMismatches) {
    const mismatchDetails: string[] = [];

    if (normalized.size > 0) {
      mismatchDetails.push(`${normalized.size} models need normalization`);
    }
    if (invalid.length > 0) {
      mismatchDetails.push(`${invalid.length} models are invalid`);
    }

    results.push({
      category: 'Models',
      name: 'Model ID validation',
      status: 'error',
      message: mismatchDetails.join(', '),
      hint: options.fix ? 'Attempting to fix...' : 'Run with --fix to normalize model IDs',
    });

    // Attempt fix if requested
    if (options.fix) {
      const fixed = await fixModelIdMismatches(modelConfig, valid, normalized, invalid);
      if (fixed) {
        results.push({
          category: 'Models',
          name: 'Auto-fix',
          status: 'success',
          message: 'Fixed model ID mismatches',
        });
      }
    }
  } else {
    results.push({
      category: 'Models',
      name: 'Model ID validation',
      status: 'success',
      message: 'All model IDs valid',
    });
  }

  // Reload config after potential fixes
  const refreshedConfig = getModelConfig();
  const currentOrchestratorModels = refreshedConfig?.orchestrator_models ?? [];

  // Default model in allowed
  const defaultModel = refreshedConfig?.default_orchestrator_model ?? '';
  const normalizedDefault = tryNormalizeModelId(defaultModel);
  const defaultInAllowed =
    currentOrchestratorModels.includes(defaultModel) ||
    (normalizedDefault && currentOrchestratorModels.includes(normalizedDefault));

  results.push({
    category: 'Models',
    name: 'Default model',
    status: defaultInAllowed ? 'success' : 'error',
    message: defaultModel,
    hint: defaultInAllowed ? undefined : 'Default model not in allowed list',
  });

  // Agent models
  const agentModels = refreshedConfig?.agent_models ?? {};
  const agentTypes = ['research', 'analyze', 'write', 'code', 'file'] as const;
  const configuredAgents = agentTypes.filter((t) => agentModels[t]);

  // Check agent model IDs for mismatches
  const agentMismatches: { agent: string; original: string; normalized: string }[] = [];
  for (const agent of agentTypes) {
    const model = agentModels[agent];
    if (model) {
      const normalized = tryNormalizeModelId(model);
      if (normalized && normalized !== model) {
        agentMismatches.push({ agent, original: model, normalized });
      }
    }
  }

  if (agentMismatches.length > 0 && options.fix) {
    for (const { agent, normalized } of agentMismatches) {
      setAgentModel(agent, normalized);
    }
    results.push({
      category: 'Models',
      name: 'Agent model fixes',
      status: 'success',
      message: `Fixed ${agentMismatches.length} agent model IDs`,
    });
  }

  results.push({
    category: 'Models',
    name: 'Agent model assignments',
    status: configuredAgents.length === agentTypes.length ? 'success' : 'warning',
    message:
      configuredAgents.length === agentTypes.length
        ? `All ${agentTypes.length} agents configured`
        : `${configuredAgents.length}/${agentTypes.length} agents configured`,
    hint:
      configuredAgents.length < agentTypes.length
        ? `Missing: ${agentTypes.filter((t) => !agentModels[t]).join(', ')}`
        : undefined,
  });

  return results;
}

/**
 * Fix model ID mismatches in the configuration.
 */
async function fixModelIdMismatches(
  modelConfig: NonNullable<ReturnType<typeof getModelConfig>>,
  validModels: string[],
  normalized: Map<string, string>,
  invalid: string[]
): Promise<boolean> {
  try {
    // Fix orchestrator models
    const newModels = [...validModels];

    // Fix default model if needed
    let newDefault = modelConfig.default_orchestrator_model;
    const normalizedDefault = tryNormalizeModelId(newDefault);
    if (normalizedDefault && !newModels.includes(normalizedDefault)) {
      newDefault = normalizedDefault;
    }

    // Ensure default is in the list
    if (!newModels.includes(newDefault) && newModels.length > 0) {
      newDefault = newModels[0];
    }

    updateOrchestratorModels(newModels, newDefault);

    console.log(chalk.green('\n✓ Fixed model configuration:'));
    if (normalized.size > 0) {
      console.log(chalk.dim('  Normalized:'));
      for (const [original, normalizedId] of normalized) {
        console.log(chalk.dim(`    ${original} → ${normalizedId}`));
      }
    }
    if (invalid.length > 0) {
      console.log(chalk.yellow('  Removed invalid:'));
      for (const model of invalid) {
        console.log(chalk.dim(`    • ${model}`));
      }
    }

    return true;
  } catch (error) {
    console.error(chalk.red('\n✗ Failed to fix model configuration:'), error);
    return false;
  }
}

// ── Result printing ──

function printResults(results: CheckResult[], options: DoctorOptions): void {
  // Group by category
  const categories = new Map<string, CheckResult[]>();
  for (const result of results) {
    const existing = categories.get(result.category) ?? [];
    existing.push(result);
    categories.set(result.category, existing);
  }

  // Print each category
  for (const [category, items] of categories) {
    printCategory(category);

    for (const item of items) {
      const icon = item.status === 'success' ? icons.success : item.status === 'warning' ? icons.warning : icons.error;

      const nameDisplay = chalk.dim(item.name + ':');
      let messageDisplay = item.message ?? '';

      if (item.status === 'success') {
        messageDisplay = colors.success(messageDisplay || 'OK');
      } else if (item.status === 'warning') {
        messageDisplay = colors.warning(messageDisplay);
      } else {
        messageDisplay = colors.error(messageDisplay);
      }

      console.log(`  ${icon} ${nameDisplay} ${messageDisplay}`);

      if (options.verbose && item.details) {
        console.log(chalk.dim(`      ${item.details}`));
      }

      if (item.hint) {
        console.log(chalk.dim(`      Hint: ${item.hint}`));
      }
    }
  }
}
