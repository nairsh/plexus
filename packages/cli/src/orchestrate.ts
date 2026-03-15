#!/usr/bin/env node
/**
 * Orchestrator CLI Tool
 * 
 * Usage:
 *   pnpm orchestrate "Research the latest on EVs"
 *   pnpm orchestrate "Research the latest on EVs" --model litellm/gemini-3.1-pro-preview
 *   pnpm orchestrate "Research the latest on EVs" --verbose
 */

// Suppress INFO logs by default (unless --verbose) - MUST be before any imports
if (!process.argv.includes('--verbose') && !process.argv.includes('-v')) {
  process.env.LOG_LEVEL = 'warn';
}

import { config } from 'dotenv';
import { resolve } from 'path';

// Load environment variables from .env file
config({ path: resolve(process.cwd(), '.env') });

import { program } from 'commander';
import { planWorkflow, executeWorkflow, getWorkflowDetails, continueWorkflow } from '@orchestrator/orchestrator';
import { getDb, runMigrations, logger } from '@orchestrator/shared';
import { getDefaultOrchestratorModel, getAllowedOrchestratorModels } from '@orchestrator/model-router';
import chalk from 'chalk';
import ora from 'ora';
import type { ChalkInstance } from 'chalk';
import { Marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import type { WorkflowTaskPlanEntry, OrchestratorThinkingData } from '@orchestrator/shared';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

// Configure markdown renderer for terminal output
const marked = new Marked({
  gfm: true,
  breaks: true,
});

// Use markedTerminal to render markdown with proper terminal formatting
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(marked as any).use(markedTerminal({
  code: chalk.cyan,
  blockquote: chalk.gray.italic,
  html: chalk.gray,
  heading: chalk.bold,
  firstHeading: chalk.bold.underline,
  hr: chalk.gray,
  listitem: chalk.white,
  table: chalk.white,
  paragraph: chalk.white,
  strong: chalk.bold,
  em: chalk.italic,
  codespan: chalk.cyan,
  del: chalk.dim.gray.strikethrough,
  link: chalk.blue.underline,
  href: chalk.blue.underline,
}));

// CLI Setup
program
  .name('orchestrate')
  .description('CLI tool for testing the orchestrator system')
  .argument('[objective]', 'The objective/query to process')
  .option('-m, --model <model>', 'Orchestrator model to use', getDefaultOrchestratorModel())
  .option('-u, --user-id <userId>', 'User ID', 'cli-user')
  .option('--max-credits <credits>', 'Maximum credits to spend', '10')
  .option('-v, --verbose', 'Show verbose output including full LLM responses')
  .option('--no-stream', 'Do not stream events, wait for completion')
  .option('--show-tools', 'Show detailed tool call input/output')
  .option('--chat', 'Start interactive chat mode on one workflow')
  .option('--continue <workflowId>', 'Continue an existing workflow with the objective argument')
  .option('--models', 'List available orchestrator models and exit')
  .parse();

const options = program.opts();
const [objective] = program.args;

// Restore INFO logs if --verbose flag is used
if (options.verbose) {
  logger.level = 'info';
}

// Handle --models flag
if (options.models) {
  console.log(chalk.bold('\n🎭 Available Orchestrator Models\n'));
  const models = getAllowedOrchestratorModels();
  const defaultModel = getDefaultOrchestratorModel();
  
  models.forEach((model) => {
    const isDefault = model === defaultModel;
    console.log(`  ${isDefault ? chalk.green('✓') : ' '} ${chalk.white(model)}${isDefault ? chalk.green(' (default)') : ''}`);
  });
  console.log('');
  console.log(chalk.dim('Usage: pnpm orchestrate "Your query" --model <model-name>'));
  console.log('');
  process.exit(0);
}

// Check for objective
if (!objective) {
  if (options.chat) {
    // chat mode can start without objective
  } else {
  console.error(chalk.red('\n❌ Error: Objective is required'));
  console.log(chalk.dim('\nUsage: pnpm orchestrate "Your query here"'));
  console.log(chalk.dim('       pnpm orchestrate --models  (to list available models)'));
  console.log('');
  process.exit(1);
  }
}

// ── Styling Configuration ──

const AGENT_COLORS = {
  research: chalk.blue,
  analyze: chalk.magenta,
  write: chalk.green,
  code: chalk.hex('#FF6B35'),
  file: chalk.gray,
};

const STATUS_ICONS = {
  initializing: chalk.gray('□'),
  running: chalk.yellow('◐'),
  completed: chalk.green('■'),
  failed: chalk.red('✗'),
  skipped: chalk.gray('□'),
};

const TREE_BRANCH = '└';
const INDENT = '  ';

let lastUpdateTodosHeader = ''; // Track last header to avoid duplicates

// Helper to truncate long descriptions
function truncateDescription(desc: string, maxLength: number = 80): string {
  if (desc.length <= maxLength) return desc;
  return desc.substring(0, maxLength - 3) + '...';
}

// Helper to print "Update Todos" header only when changed
function printUpdateTodosHeader(status: 'initial' | 'running' | 'completed' | 'failed'): void {
  const header = `${status}-todos`;
  if (lastUpdateTodosHeader === header) return;
  lastUpdateTodosHeader = header;
  
  const icon = status === 'running' ? chalk.yellow('◐') : 
               status === 'completed' ? chalk.green('●') :
               status === 'failed' ? chalk.red('●') :
               chalk.green('●');
  console.log(`${icon} Update Todos`);
}

// ── State Management ──

interface TaskState {
  id: string;
  description: string;
  agentType: string;
  status: 'initializing' | 'running' | 'completed' | 'failed' | 'skipped';
  toolCalls: Array<{ name: string; input: unknown; output?: unknown }>;
  output?: string;
  error?: string;
  headerPrinted: boolean;
  startedLogged: boolean;
  origin?: string;
  outputArtifact?: string;
  model?: string;
  usage?: { total_tokens?: number; input_tokens?: number; output_tokens?: number; model?: string };
  outputLineCount?: number;
  outputWordCount?: number;
}

const tasks = new Map<string, TaskState>();
let isFirstOutput = true;
let lastRenderedThinking: string | null = null;
const toolResultByTask = new Map<string, number>();

// ── Rendering Helpers ──

function renderTaskHeader(task: TaskState): void {
  if (task.headerPrinted) return;
  task.headerPrinted = true;

  const color = AGENT_COLORS[task.agentType as keyof typeof AGENT_COLORS] || chalk.white;
  const checkbox = STATUS_ICONS[task.status];
  const shortDesc = truncateDescription(task.description);

  // Format: □ Description (colored when running)
  const text = task.status === 'running' ? color(shortDesc) : chalk.white(shortDesc);
  console.log(`${INDENT}${TREE_BRANCH} ${checkbox} ${text}`);
}

function renderToolCall(task: TaskState, toolCall: { name: string; input: unknown }): void {
  const toolName = toolCall.name;
  let toolDisplay = '';
  
  switch (toolName) {
    case 'web_search': {
      const searchInput = toolCall.input as { query?: string };
      toolDisplay = `search: "${searchInput.query || ''}"`;
      break;
    }
    case 'fetch_url': {
      const fetchInput = toolCall.input as { url?: string };
      toolDisplay = `fetch: ${fetchInput.url || ''}`;
      break;
    }
    case 'bash': {
      const bashInput = toolCall.input as { command?: string };
      toolDisplay = `bash: ${bashInput.command || ''}`;
      break;
    }
    case 'file_read':
    case 'file_write':
    case 'file_edit': {
      const fileInput = toolCall.input as { path?: string };
      toolDisplay = `${toolName.replace('file_', '')}: ${fileInput.path || ''}`;
      break;
    }
    default:
      toolDisplay = `${toolName}(...)`;
  }
  
  // Indent twice for tool calls (under task)
  console.log(`${INDENT}${INDENT}${chalk.gray('•')} ${chalk.dim(toolDisplay)}`);
}

function formatTokenCount(totalTokens?: number): string {
  if (!totalTokens || totalTokens <= 0) return '0 tokens';
  if (totalTokens >= 1_000_000) return `${(totalTokens / 1_000_000).toFixed(1)}M tokens`;
  if (totalTokens >= 1_000) return `${(totalTokens / 1_000).toFixed(totalTokens >= 10_000 ? 0 : 1)}k tokens`;
  return `${totalTokens} tokens`;
}

function renderTaskStarted(task: TaskState): void {
  if (task.startedLogged) return;
  task.startedLogged = true;

  // Header was already printed by renderTaskHeader, just print the metadata line
  const extras: string[] = [];
  if (task.model) extras.push(chalk.dim(task.model));
  if (task.origin) extras.push(chalk.dim(task.origin));
  if (task.outputArtifact) extras.push(chalk.dim(task.outputArtifact));

  if (extras.length > 0) {
    console.log(`${INDENT}${INDENT}${chalk.gray('→')} ${extras.join(chalk.gray(' · '))}`);
  }
}

function renderTaskCompleted(task: TaskState): void {
  const checkbox = STATUS_ICONS.completed;

  // Re-render with completed checkbox
  console.log(`${INDENT}${TREE_BRANCH} ${checkbox} ${chalk.white(truncateDescription(task.description))}`);

  // Show summary on next line
  const parts: string[] = [];
  const toolUseCount = toolResultByTask.get(task.id) ?? task.toolCalls.length;
  if (toolUseCount > 0) {
    parts.push(chalk.gray(`${toolUseCount} tool ${toolUseCount === 1 ? 'use' : 'uses'}`));
  }
  if (task.usage?.total_tokens) {
    parts.push(chalk.gray(formatTokenCount(task.usage.total_tokens)));
  }
  if (task.outputLineCount && task.agentType === 'write') {
    parts.push(chalk.gray(`${task.outputLineCount} lines`));
  }
  if (task.outputWordCount && task.agentType !== 'write') {
    parts.push(chalk.gray(`${task.outputWordCount} words`));
  }

  if (parts.length > 0) {
    console.log(`${INDENT}${INDENT}${chalk.gray('✓')} ${parts.join(chalk.gray(' · '))}`);
  }
}

function shouldSuppressThinking(thinking: string, _mode?: OrchestratorThinkingData['mode']): boolean {
  // Always show orchestrator thinking - don't suppress
  if (thinking === lastRenderedThinking) {
    return true;
  }

  lastRenderedThinking = thinking;
  return false;
}

function renderOrchestratorThinking(thinking: string, _iteration: number): void {
  if (isFirstOutput) {
    console.log('');
    isFirstOutput = false;
  }

  // Show orchestrator thinking with white dot like in the reference image
  console.log(`${chalk.white('●')} ${chalk.white(thinking.trim())}`);
  console.log('');
}

// ── Main Execution ──

async function streamWorkflow(workflowId: string): Promise<void> {
  for await (const event of executeWorkflow(workflowId)) {
    switch (event.type) {
      case 'tasks_initialized': {
        const data = event.data as { tasks: WorkflowTaskPlanEntry[] };
        printUpdateTodosHeader('initial');
        data.tasks.forEach(t => {
          tasks.set(t.id, {
            id: t.id,
            description: t.description,
            agentType: t.agent_type,
            status: 'initializing',
            toolCalls: [],
            headerPrinted: false,
            startedLogged: false,
            origin: (t as { origin?: string }).origin,
            outputArtifact: (t as { output_artifact?: string }).output_artifact,
          });
          const checkbox = STATUS_ICONS.initializing;
          console.log(`${INDENT}${TREE_BRANCH} ${checkbox} ${chalk.white(truncateDescription(t.description))}`);
        });
        console.log('');
        break;
      }
      case 'orchestrator_thinking': {
        const data = event.data as OrchestratorThinkingData;
        if (!shouldSuppressThinking(data.thinking, data.mode)) {
          renderOrchestratorThinking(data.thinking, data.iteration);
        }
        break;
      }
      case 'task_started': {
        const data = event.data as { description: string; agent_type?: string; task_type?: string; origin?: string; output_artifact?: string; model?: string };
        const agentType = data.agent_type || data.task_type || 'task';
        const taskId = (event as { task_id?: string }).task_id || '';
        printUpdateTodosHeader('running');
        if (taskId && tasks.has(taskId)) {
          const task = tasks.get(taskId)!;
          if (task.status !== 'running' || !task.startedLogged) {
            task.status = 'running';
            task.origin = data.origin || task.origin;
            task.outputArtifact = data.output_artifact || task.outputArtifact;
            task.model = data.model || task.model;
            renderTaskHeader(task);
            renderTaskStarted(task);
          }
        } else {
          tasks.set(taskId, {
            id: taskId,
            description: data.description,
            agentType,
            status: 'running',
            toolCalls: [],
            headerPrinted: false,
            startedLogged: false,
            origin: data.origin,
            outputArtifact: data.output_artifact,
            model: data.model,
          });
          const task = tasks.get(taskId)!;
          renderTaskHeader(task);
          renderTaskStarted(task);
        }
        break;
      }
      case 'subagent_tool_call': {
        const data = event.data as { tool_name: string; tool_input: unknown };
        const taskId = (event as { task_id?: string }).task_id || '';
        if (taskId && tasks.has(taskId)) {
          const task = tasks.get(taskId)!;
          task.toolCalls.push({ name: data.tool_name, input: data.tool_input });
          if (!task.headerPrinted) {
            renderTaskHeader(task);
          }
          renderToolCall(task, { name: data.tool_name, input: data.tool_input });
        }
        break;
      }
      case 'subagent_tool_result': {
        const taskId = (event as { task_id?: string }).task_id || '';
        if (taskId) {
          toolResultByTask.set(taskId, (toolResultByTask.get(taskId) ?? 0) + 1);
        }
        break;
      }
      case 'task_added': {
        const data = event.data as { description: string; agent_type: string; origin?: string; output_artifact?: string };
        const taskId = (event as { task_id?: string }).task_id || '';
        tasks.set(taskId, {
          id: taskId,
          description: data.description,
          agentType: data.agent_type,
          status: 'initializing',
          toolCalls: [],
          headerPrinted: false,
          startedLogged: false,
          origin: data.origin,
          outputArtifact: data.output_artifact,
        });
        break;
      }
      case 'task_reused': {
        const taskId = (event as { task_id?: string }).task_id || '';
        const data = event.data as { reason?: string; origin?: string };
        const task = taskId ? tasks.get(taskId) : undefined;
        if (task) {
          printUpdateTodosHeader('completed');
          console.log(`${INDENT}${TREE_BRANCH} ${STATUS_ICONS.completed} ${chalk.white(truncateDescription(task.description))}`);
          console.log(`${INDENT}${INDENT}${chalk.gray('→')} ${chalk.gray(`reused${data.reason ? ` · ${data.reason}` : ''}`)}`);
          if (data.origin) {
            task.origin = data.origin;
          }
        }
        break;
      }
      case 'task_skipped': {
        const taskId = (event as { task_id?: string }).task_id || '';
        if (taskId && tasks.has(taskId)) {
          tasks.get(taskId)!.status = 'skipped';
        }
        break;
      }
      case 'task_completed': {
        const taskId = (event as { task_id?: string }).task_id || '';
        const data = event.data as {
          output_preview?: string;
          usage?: { total_tokens?: number; input_tokens?: number; output_tokens?: number; model?: string };
          output_line_count?: number;
          output_word_count?: number;
        };
        if (taskId && tasks.has(taskId)) {
          const task = tasks.get(taskId)!;
          task.status = 'completed';
          task.output = data.output_preview;
          task.usage = data.usage;
          task.outputLineCount = data.output_line_count;
          task.outputWordCount = data.output_word_count;
          printUpdateTodosHeader('completed');
          renderTaskCompleted(task);
        }
        break;
      }
      case 'task_failed': {
        const taskId = (event as { task_id?: string }).task_id || '';
        const data = event.data as { error?: string };
        if (taskId && tasks.has(taskId)) {
          const task = tasks.get(taskId)!;
          task.status = 'failed';
          task.error = data.error;
          printUpdateTodosHeader('failed');
          console.log(`${INDENT}${TREE_BRANCH} ${STATUS_ICONS.failed} ${chalk.red(truncateDescription(task.description))}`);
          if (data.error) {
            console.log(`${INDENT}${INDENT}${chalk.gray('→')} ${chalk.red(data.error)}`);
          }
        }
        break;
      }
      case 'workflow_completed': {
        const data = event.data as { output?: string; total_credits?: number };
        console.log('');
        console.log(chalk.bold('═'.repeat(60)));
        console.log(chalk.green.bold('✓ WORKFLOW COMPLETED'));
        console.log(chalk.bold('═'.repeat(60)));
        console.log('');
        const output = data.output || 'No output';
        try {
          const rendered = marked.parse(output) as string;
          console.log(rendered);
        } catch {
          console.log(chalk.white(output));
        }
        console.log('');
        console.log(chalk.dim(`Credits used: ${data.total_credits?.toFixed(4) || '0'}`));
        console.log('');
        break;
      }
      case 'workflow_failed': {
        const data = event.data as { error?: string };
        console.log('');
        console.log(chalk.bold('═'.repeat(60)));
        console.log(chalk.red.bold('✗ WORKFLOW FAILED'));
        console.log(chalk.bold('═'.repeat(60)));
        console.log('');
        console.log(chalk.red(data.error || 'Unknown error'));
        console.log('');
        break;
      }
      default:
        break;
    }
  }
}

async function main() {
  console.log(chalk.bold('\n🎭 Orchestrator CLI\n'));
  if (objective) {
    console.log(`${chalk.white('●')} ${chalk.white(objective)}`);
  }
  console.log('');

  // Validate model
  const allowedModels = getAllowedOrchestratorModels();
  if (!allowedModels.includes(options.model)) {
    console.log(chalk.yellow(`⚠️  Warning: Model "${options.model}" not in allowed list.`));
    console.log(chalk.dim('Allowed models:'), allowedModels.join(', '));
    console.log('');
  }

  // Setup
  await runMigrations();
  
  // Ensure user exists
  const db = getDb();
  const userExists = db.prepare('SELECT 1 FROM users WHERE id = ?').get(options.userId);
  if (!userExists) {
    db.prepare(
      "INSERT INTO users (id, email, tier, credits_balance, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
    ).run(options.userId, `${options.userId}@localhost`, 'pro', 10000);
  }
  
  const spinner = ora({
    text: 'Starting workflow...',
    spinner: 'dots',
    color: 'cyan'
  });

  let workflowId: string;

  try {
    if (options.chat) {
      spinner.stop();
      const rl = createInterface({ input, output });
      try {
        let currentWorkflowId = options.continue as string | undefined;
        let pendingPrompt = objective as string | undefined;

        while (true) {
          let prompt: string;
          if (pendingPrompt) {
            prompt = pendingPrompt;
          } else {
            try {
              prompt = (await rl.question(chalk.gray('You > '))).trim();
            } catch {
              break;
            }
          }
          pendingPrompt = undefined;

          if (!prompt) continue;
          if (prompt === '/exit' || prompt === '/quit') break;

          console.log('');
          console.log(`${chalk.white('●')} ${chalk.white(prompt)}`);
          console.log('');

          if (currentWorkflowId) {
            spinner.start('Continuing workflow...');
            await continueWorkflow(currentWorkflowId, prompt);
            spinner.succeed(`Workflow continued: ${chalk.cyan(currentWorkflowId.substring(0, 8))}`);
          } else {
            spinner.start('Starting workflow...');
            const result = await planWorkflow(options.userId, {
              objective: prompt,
              orchestrator_model: options.model,
              max_credits: parseFloat(options.maxCredits),
            });
            currentWorkflowId = result.workflowId;
            spinner.succeed(`Workflow started: ${chalk.cyan(currentWorkflowId.substring(0, 8))}`);
          }

          await streamWorkflow(currentWorkflowId);
          console.log(chalk.dim('Type /exit to quit chat mode.'));
          console.log('');
        }
      } finally {
        rl.close();
      }

      return;
    }

    if (options.continue) {
      if (!objective) {
        throw new Error('Objective is required when using --continue');
      }
      workflowId = options.continue;
      spinner.start('Continuing workflow...');
      await continueWorkflow(workflowId, objective);
      spinner.succeed(`Workflow continued: ${chalk.cyan(workflowId.substring(0, 8))}`);
    } else {
      spinner.start('Starting workflow...');
      const result = await planWorkflow(options.userId, {
        objective: objective ?? 'Hello',
        orchestrator_model: options.model,
        max_credits: parseFloat(options.maxCredits),
      });
      workflowId = result.workflowId;
      spinner.succeed(`Workflow started: ${chalk.cyan(workflowId.substring(0, 8))}`);
    }
    console.log('');

    if (!options.stream) {
      // Non-streaming mode
      spinner.start('Executing workflow...');
      const stream = executeWorkflow(workflowId);
      await stream.done;
      spinner.stop();
      
      // Show final result
      const details = getWorkflowDetails(workflowId);
      console.log('\n' + chalk.bold('═'.repeat(60)));
      console.log(chalk.bold('FINAL OUTPUT'));
      console.log(chalk.bold('═'.repeat(60)));
      if (details?.workflow?.output) {
        try {
          const rendered = marked.parse(details.workflow.output) as string;
          console.log(rendered);
        } catch {
          console.log(chalk.white(details.workflow.output));
        }
      } else if (details?.tasks?.length) {
        console.log(details.tasks.map((t) => `• ${t.description} [${t.status}]`).join('\n'));
      } else {
        console.log('No output');
      }
      console.log('');
      return;
    }

    // Streaming mode - show real-time events
    await streamWorkflow(workflowId);

  } catch (error) {
    spinner.stop();
    console.error(chalk.red('\n❌ Error:'), error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log(chalk.yellow('\n\n⚠️  Interrupted by user'));
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log(chalk.yellow('\n\n⚠️  Terminated'));
  process.exit(0);
});

// Run
main().catch((error) => {
  console.error(chalk.red('\n❌ Fatal Error:'), error);
  process.exit(1);
});
