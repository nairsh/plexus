#!/usr/bin/env node

if (!process.argv.includes('--verbose') && !process.argv.includes('-v')) {
  process.env.LOG_LEVEL = 'warn';
}

import { config } from 'dotenv';
import { resolve as resolvePath } from 'node:path';
import { program } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { getDb, getErrorMessage, runMigrations, logger } from '@orchestrator/shared';
import { getAllowedOrchestratorModels, getDefaultOrchestratorModel } from '@orchestrator/model-router';
import { cancelWorkflow } from '@orchestrator/orchestrator';
import { ChatApp as ChatScreen } from './ui/chat-app-bridge.js';
import { CLI_VERSION } from './version.js';
import { printAsciiLogo, prettifyModelLabel, formatJsonOutput } from './orchestrate/output.js';
import { runInteractiveChat } from './orchestrate/interactive.js';
import { runNonInteractive } from './orchestrate/non-interactive.js';
import { getCliAuthSubject } from './cli/auth.js';

interface CliOptions {
  prompt?: string;
  model: string;
  userId: string;
  maxCredits: string;
  verbose?: boolean;
  stream: boolean;
  continue?: string;
  models?: boolean;
  json?: boolean;
  output?: string;
}

config({ path: resolvePath(process.cwd(), '.env') });

program
  .name('orchestrate')
  .description('AI orchestrator platform CLI - Multi-agent workflow orchestration')
  .version(CLI_VERSION)
  .argument('[objective]', 'Objective to accomplish (runs non-interactively if provided)')
  .option('-p, --prompt <text>', 'Explicit prompt for non-interactive mode (alternative to positional argument)')
  .option('-m, --model <model>', 'Orchestrator model to use', getDefaultOrchestratorModel())
  .option('-u, --user-id <userId>', 'User ID for the workflow', 'cli-user')
  .option('--max-credits <credits>', 'Maximum credits to spend', '10')
  .option('-v, --verbose', 'Show verbose output including full LLM responses')
  .option('--no-stream', 'Do not stream events, wait for completion (non-interactive only)')
  .option('--show-tools', 'Show detailed tool call input/output')
  .option('--continue <workflowId>', 'Continue an existing workflow')
  .option('--models', 'List available orchestrator models and exit')
  .option('--json', 'Output results as JSON (non-interactive only)')
  .option('--output <file>', 'Save output to file (non-interactive only)')
  .addHelpText('after', `
Examples:
  $ orchestrate                              Start interactive chat mode
  $ orchestrate "Research latest AI news"    Run a single objective
  $ orchestrate -p "Write Python script"     Use explicit prompt flag
  $ orchestrate "Research" -m gemini-3-pro   Specify model
  $ orchestrate --continue wf_abc123 "More"  Continue existing workflow
  $ orchestrate --models                     List available models

Interactive Chat Commands:
  /help     Show available commands
  /model    Open model selector
  /continue Open workflow history
  /exit     Exit chat mode
`);

program.parse();

const options = program.opts<{
  prompt?: string;
  model: string;
  userId: string;
  maxCredits: string;
  verbose?: boolean;
  stream: boolean;
  continue?: string;
  models?: boolean;
  json?: boolean;
  output?: string;
}>() as CliOptions;

const [positionalObjective] = program.args;
const objective = options.prompt || positionalObjective;
const isInteractive = !objective && !options.continue && !options.models;
const userIdProvided = process.argv.includes('--user-id') || process.argv.includes('-u');

logger.level = options.verbose ? 'info' : 'warn';

const ensureUserExists = async (userId: string): Promise<void> => {
  await runMigrations();
  const db = getDb();
  const userExists = db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId);
  if (!userExists) {
    db.prepare(
      "INSERT INTO users (id, email, tier, credits_balance, created_at) VALUES (?, ?, ?, ?, datetime('now'))",
    ).run(userId, `${userId}@localhost`, 'pro', 10000);
  }
};

const printModels = (): never => {
  printAsciiLogo('Available Orchestrator Models');
  const models = getAllowedOrchestratorModels();
  const defaultModel = getDefaultOrchestratorModel();

  for (const model of models) {
    const isDefault = model === defaultModel;
    console.log(`  ${isDefault ? chalk.green('✓') : ' '} ${chalk.white(model)}${isDefault ? chalk.green(' (default)') : ''}`);
  }
  console.log('');
  console.log(chalk.dim('Usage: orchestrate "Your query" --model <model-name>'));
  console.log('');
  process.exit(0);
};

const validateModel = (model: string): void => {
  const allowedModels = getAllowedOrchestratorModels();
  if (!allowedModels.includes(model)) {
    console.log(chalk.yellow(`⚠️  Warning: Model "${model}" not in allowed list.`));
    console.log(chalk.dim('Allowed models:'), allowedModels.join(', '));
    console.log('');
  }
};

const run = async (): Promise<void> => {
  if (options.models) {
    printModels();
  }

  if (!userIdProvided) {
    const subject = await getCliAuthSubject();
    if (subject) {
      options.userId = subject;
    }
  }

  await ensureUserExists(options.userId);
  validateModel(options.model);

  if (isInteractive) {
    let activeWorkflowId: string | null = null;
    const chatScreen = new ChatScreen(
      prettifyModelLabel(options.model),
      resolvePath(process.cwd()),
      () => {
        if (activeWorkflowId) {
          cancelWorkflow(activeWorkflowId);
        }
      },
    );
    chatScreen.start();
    try {
      await runInteractiveChat(chatScreen, {
        userId: options.userId,
        model: options.model,
        maxCredits: options.maxCredits,
        onWorkflowIdChange: (workflowId) => {
          activeWorkflowId = workflowId;
        },
      });
    } finally {
      activeWorkflowId = null;
      chatScreen.stop();
    }
    return;
  }

  if (!objective && !options.continue) {
    console.error(chalk.red('\n❌ Error: Objective is required for non-interactive mode'));
    console.log(chalk.dim('\nUsage: orchestrate "Your query here"'));
    console.log(chalk.dim('       orchestrate --prompt "Your query here"'));
    console.log(chalk.dim('       orchestrate              (for interactive chat mode)'));
    console.log('');
    process.exit(1);
  }

  if (!options.json) {
    printAsciiLogo('Orchestrator CLI');
    if (objective) {
      console.log(`${chalk.white('●')} ${chalk.white(objective)}`);
      console.log('');
    }
  }

  const spinner = ora({
    text: 'Starting workflow...',
    spinner: 'dots',
    color: 'cyan',
  });

  try {
    const result = await runNonInteractive({
      objective: objective!,
      continueWorkflowId: options.continue,
      model: options.model,
      userId: options.userId,
      maxCredits: options.maxCredits,
      stream: options.stream,
      json: Boolean(options.json),
      output: options.output,
      spinner,
    });

    if (options.json && result.workflowId) {
      console.log(formatJsonOutput(result));
    }
  } catch (error) {
    spinner.stop();
    const errorMessage = getErrorMessage(error, 'CLI execution failed');
    if (options.json) {
      console.log(formatJsonOutput({ error: errorMessage }));
    } else {
      console.error(chalk.red('\n❌ Error:'), errorMessage);
    }
    process.exit(1);
  }
};

process.on('SIGINT', () => {
  console.log(chalk.yellow('\n\n⚠️  Interrupted by user'));
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log(chalk.yellow('\n\n⚠️  Terminated'));
  process.exit(0);
});

run().catch((error) => {
  console.error(chalk.red('\n❌ Fatal Error:'), getErrorMessage(error, 'CLI execution failed'));
  process.exit(1);
});
