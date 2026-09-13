#!/usr/bin/env node
/**
 * Orchestrator CLI
 *
 * Main entry point for the orchestrator platform CLI.
 * Provides onboarding, configuration, health checks, and orchestration.
 */

import { config } from 'dotenv';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

// Load .env file if it exists
if (existsSync(resolve('.env'))) {
  config({ path: resolve('.env') });
}

import { program } from 'commander';
import chalk from 'chalk';
import { runOnboarding } from './onboarding.js';
import { runDoctor } from './doctor.js';
import { runConfig, printConfigHelp } from './config.js';
import { runModels, printModelsHelp } from './models.js';
import { runConfigure } from './configure.js';
import { runAuth } from './auth.js';
import { CLI_VERSION } from '../version.js';

// ── Main program ──

program.name('orchestrator').description('AI orchestrator platform CLI').version(CLI_VERSION);

// ── Configure command (interactive) ──

program
  .command('configure')
  .alias('config-interactive')
  .description('Interactive menu-driven configuration')
  .action(async () => {
    await runConfigure();
  });

// ── Onboarding command ──

program
  .command('onboarding')
  .description('Interactive first-time setup wizard')
  .option('--non-interactive', 'Use defaults, no prompts')
  .option('--skip-models', 'Skip model configuration')
  .action(async (options) => {
    await runOnboarding(options);
  });

// ── Doctor command ──

program
  .command('doctor')
  .description('Health check and diagnostics')
  .option('-v, --verbose', 'Show detailed output')
  .option('--fix', 'Attempt to auto-fix issues')
  .action(async (options) => {
    await runDoctor(options);
  });

// ── Config command ──

program
  .command('config [action]')
  .description('Configuration management')
  .option('-k, --key <key>', 'Configuration key')
  .option('-v, --value <value>', 'Configuration value')
  .action(async (action = 'list', options) => {
    if (action === 'help') {
      printConfigHelp();
      return;
    }
    await runConfig(action, options);
  });

// ── Models command ──

program
  .command('models [action]')
  .description('Model management')
  .option('-a, --agent <agent>', 'Agent type (research, analyze, write, code, file)')
  .option('-m, --model <model>', 'Model ID')
  .action(async (action = 'list', options) => {
    if (action === 'help') {
      printModelsHelp();
      return;
    }
    await runModels(action, options);
  });

// ── Auth command ──

program
  .command('auth <action>')
  .description('Authentication commands (login, logout, status)')
  .action(async (action: 'login' | 'logout' | 'status') => {
    if (!['login', 'logout', 'status'].includes(action)) {
      console.log(chalk.red('Unknown auth action. Use: login | logout | status'));
      process.exit(1);
    }

    await runAuth(action);
  });

// ── Run command (delegate to orchestrate.ts) ──

program
  .command('run [objective]', { hidden: true })
  .description('Run the orchestrator with an objective')
  .option('-m, --model <model>', 'Orchestrator model to use')
  .option('-u, --user-id <userId>', 'User ID', 'cli-user')
  .option('--max-credits <credits>', 'Maximum credits to spend', '10')
  .option('-v, --verbose', 'Show verbose output')
  .option('--no-stream', 'Do not stream events')
  .action(async (objective, options) => {
    // This delegates to the existing orchestrate.ts
    console.log(chalk.yellow('Note: Use "pnpm orchestrate" for the full orchestrator CLI.'));
    console.log(chalk.dim('Or run: orchestrator <objective>'));
  });

// ── Default: pass-through to orchestrate ──

// If no recognized subcommand, treat as objective for orchestrator
const args = process.argv.slice(2);

if (
  args.length > 0 &&
  !args[0].startsWith('-') &&
  !['onboarding', 'doctor', 'config', 'models', 'run', 'help', 'configure', 'config-interactive', 'auth'].includes(
    args[0]
  )
) {
  // This looks like an objective, not a command
  // Delegate to orchestrate.ts
  console.log(chalk.dim('Running orchestrator...'));
  console.log(chalk.dim('Tip: Use "orchestrator configure" for interactive setup.\n'));

  // Import and run orchestrate
  await import('../orchestrate.js');
} else {
  // Parse commands normally
  program.parse();
}

// ── Error handling ──

process.on('uncaughtException', (error) => {
  console.error(chalk.red('\n❌ Error:'), error.message);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error(chalk.red('\n❌ Error:'), reason instanceof Error ? reason.message : String(reason));
  process.exit(1);
});
