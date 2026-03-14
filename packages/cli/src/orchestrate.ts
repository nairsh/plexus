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
import { planWorkflow, executeWorkflow, getWorkflowDetails } from '@orchestrator/orchestrator';
import { getDb, runMigrations, logger } from '@orchestrator/shared';
import { getDefaultOrchestratorModel, getAllowedOrchestratorModels } from '@orchestrator/model-router';
import chalk from 'chalk';
import ora from 'ora';
import type { ChalkInstance } from 'chalk';
import { Marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import type { WorkflowTaskPlanEntry, OrchestratorThinkingData } from '@orchestrator/shared';

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
  console.error(chalk.red('\n❌ Error: Objective is required'));
  console.log(chalk.dim('\nUsage: pnpm orchestrate "Your query here"'));
  console.log(chalk.dim('       pnpm orchestrate --models  (to list available models)'));
  console.log('');
  process.exit(1);
}

// ── Styling Configuration ──

const AGENT_BADGES: Record<string, { bg: ChalkInstance; text: ChalkInstance; description: string }> = {
  research: { bg: chalk.bgBlue, text: chalk.blue, description: 'Gather information from web sources' },
  analyze: { bg: chalk.bgMagenta, text: chalk.magenta, description: 'Synthesize findings and provide insights' },
  write: { bg: chalk.bgGreen, text: chalk.green, description: 'Produce polished written content' },
  code: { bg: chalk.bgHex('#FF6B35'), text: chalk.hex('#FF6B35'), description: 'Write and execute code in sandbox' },
  file: { bg: chalk.bgGray, text: chalk.gray, description: 'Perform file system operations' },
};

const STATUS_ICONS = {
  initializing: chalk.gray('└'),
  running: chalk.yellow('└'),
  completed: chalk.green('└'),
  failed: chalk.red('└'),
  skipped: chalk.gray('└'),
};

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
  usage?: { total_tokens?: number; input_tokens?: number; output_tokens?: number; model?: string };
  outputLineCount?: number;
  outputWordCount?: number;
}

const tasks = new Map<string, TaskState>();
let isFirstOutput = true;
let lastRenderedThinking: string | null = null;
const toolResultByTask = new Map<string, number>();

// ── Rendering Helpers ──

function renderAgentBadge(agentType: string): string {
  const badge = AGENT_BADGES[agentType] || { bg: chalk.bgWhite, text: chalk.white, description: '' };
  const paddedType = ` ${agentType} `;
  // Use black text on colored background
  return chalk.bold(badge.bg(paddedType));
}

function renderTaskHeader(task: TaskState): void {
  if (task.headerPrinted) return;
  task.headerPrinted = true;
  
  const badge = renderAgentBadge(task.agentType);
  const desc = chalk.white(`(${task.description})`);
  console.log(`${badge}${desc}`);
}

function renderToolCall(task: TaskState, toolCall: { name: string; input: unknown }): void {
  const toolName = toolCall.name;
  let toolDisplay = '';
  
  switch (toolName) {
    case 'web_search': {
      const searchInput = toolCall.input as { query?: string };
      toolDisplay = `Search(${searchInput.query || ''})`;
      break;
    }
    case 'fetch_url': {
      const fetchInput = toolCall.input as { url?: string };
      toolDisplay = `Fetch(${fetchInput.url || ''})`;
      break;
    }
    case 'bash': {
      const bashInput = toolCall.input as { command?: string };
      toolDisplay = `Bash(${bashInput.command || ''})`;
      break;
    }
    case 'file_read':
    case 'file_write':
    case 'file_edit': {
      const fileInput = toolCall.input as { path?: string };
      toolDisplay = `${toolName.replace('file_', '')}(${fileInput.path || ''})`;
      break;
    }
    default:
      toolDisplay = `${toolName}(...)`;
  }
  
  const indent = '  ';
  const icon = STATUS_ICONS[task.status] || STATUS_ICONS.initializing;
  console.log(`${indent}${icon} ${chalk.white(toolDisplay)}`);
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

  const extras = [
    task.origin ?? null,
    task.outputArtifact ?? null,
  ].filter(Boolean).join(chalk.gray(' · '));

  console.log(`  ${STATUS_ICONS.running} ${chalk.yellow('Started')}${extras ? `${chalk.gray(' · ')}${chalk.gray(extras)}` : ''}`);
}

function renderTaskCompleted(task: TaskState): void {
  const toolUseCount = toolResultByTask.get(task.id) ?? task.toolCalls.length;
  const parts = [chalk.green('Done'), chalk.gray(`${toolUseCount} tool ${toolUseCount === 1 ? 'use' : 'uses'}`)];

  if (task.usage?.total_tokens) {
    parts.push(chalk.gray(formatTokenCount(task.usage.total_tokens)));
  }
  if (task.outputLineCount && task.agentType === 'write') {
    parts.push(chalk.gray(`wrote ${task.outputLineCount} lines`));
  }
  if (task.outputWordCount && task.agentType !== 'write') {
    parts.push(chalk.gray(`${task.outputWordCount} words`));
  }

  console.log(`  ${STATUS_ICONS.completed} ${parts.join(chalk.gray(' · '))}`);
}

function shouldSuppressThinking(thinking: string, mode?: OrchestratorThinkingData['mode']): boolean {
  if (thinking === lastRenderedThinking) {
    return true;
  }

  if (mode === 'direct_dispatch' || thinking.startsWith('Direct dispatch:')) {
    lastRenderedThinking = thinking;
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
  
  // Parse the thinking to extract complexity and plan
  const lines = thinking.split('\n').filter(l => l.trim());
  
  lines.forEach(line => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    
    // Highlight key sections
    if (trimmed.startsWith('**Complexity:')) {
      const complexityMatch = trimmed.match(/\*\*Complexity:\s*(\w+)\*\*/);
      const complexity = complexityMatch ? complexityMatch[1] : 'STANDARD';
      const rest = trimmed.split('—')[1]?.trim() || '';
      console.log(`  ${chalk.yellow('●')} ${chalk.white('This is a')} ${chalk.bold.yellow(complexity.toUpperCase())} ${chalk.white('complexity request')} — ${rest}`);
    } else if (trimmed.startsWith("I'll")) {
      console.log(`  ${chalk.white(trimmed)}`);
    } else if (trimmed.includes('deploy') || trimmed.includes('specialist')) {
      console.log(`  ${chalk.cyan('●')} ${chalk.white(trimmed)}`);
    } else {
      console.log(`  ${chalk.white(trimmed)}`);
    }
  });
  
  console.log('');
}

// ── Main Execution ──

async function main() {
  console.log(chalk.bold('\n🎭 Orchestrator CLI\n'));
  console.log(chalk.dim('Objective:'), chalk.white(objective));
  console.log(chalk.dim('Model:'), chalk.cyan(options.model));
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
      'INSERT INTO users (id, email, tier, credits_balance, created_at) VALUES (?, ?, ?, ?, datetime("now"))'
    ).run(options.userId, `${options.userId}@localhost`, 'pro', 10000);
  }
  
  const spinner = ora({
    text: 'Planning workflow...',
    spinner: 'dots',
    color: 'cyan'
  }).start();

  let workflowId: string;

  try {
    // Plan the workflow
    const result = await planWorkflow(options.userId, {
      objective,
      orchestrator_model: options.model,
      max_credits: parseFloat(options.maxCredits),
    });

    workflowId = result.workflowId;
    spinner.succeed(`Workflow planned: ${chalk.cyan(workflowId.substring(0, 8))}`);
    console.log('');

    if (!options.stream) {
      // Non-streaming mode
      spinner.start('Executing workflow...');
      for await (const _ of executeWorkflow(workflowId)) {
        // Just consume events
      }
      spinner.stop();
      
      // Show final result
      const details = getWorkflowDetails(workflowId);
      console.log('\n' + chalk.bold('═'.repeat(60)));
      console.log(chalk.bold('FINAL OUTPUT'));
      console.log(chalk.bold('═'.repeat(60)));
      console.log(details?.plan ? JSON.parse(JSON.stringify(details.plan)).tasks.map((t: any) => 
        `• ${t.description}`
      ).join('\n') : 'No tasks');
      console.log('');
      return;
    }

    // Streaming mode - show real-time events
    for await (const event of executeWorkflow(workflowId)) {
      switch (event.type) {
        case 'tasks_initialized': {
          const data = event.data as { tasks: WorkflowTaskPlanEntry[] };
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
          });
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
          const data = event.data as { description: string; agent_type?: string; task_type?: string; origin?: string; output_artifact?: string };
          const agentType = data.agent_type || data.task_type || 'task';
          const taskId = (event as { task_id?: string }).task_id || '';
          
          if (taskId && tasks.has(taskId)) {
            const task = tasks.get(taskId)!;
            task.status = 'running';
            task.origin = data.origin || task.origin;
            task.outputArtifact = data.output_artifact || task.outputArtifact;
            renderTaskHeader(task);
            renderTaskStarted(task);
          } else {
            // New task that wasn't in initial plan
            tasks.set(taskId, {
              id: taskId,
              description: data.description,
              agentType: agentType,
              status: 'running',
              toolCalls: [],
              headerPrinted: false,
              startedLogged: false,
              origin: data.origin,
              outputArtifact: data.output_artifact,
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
            
            // Ensure header is printed before tool calls
            if (!task.headerPrinted) {
              renderTaskHeader(task);
            }
            
            // Render this tool call
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
            renderTaskHeader(task);
            console.log(`  ${chalk.gray('└')} ${chalk.gray(`Reused existing task${data.reason ? ` · ${data.reason}` : ''}`)}`);
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
            
            if (task.headerPrinted) {
              renderTaskCompleted(task);
            }
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
            
            if (task.headerPrinted) {
              console.log(`  ${STATUS_ICONS.failed} ${chalk.red(data.error || 'Failed')}`);
            }
          }
          break;
        }

        case 'task_dispatched': {
          break;
        }

        case 'workflow_completed': {
          const data = event.data as { output?: string; total_credits?: number };
          console.log('');
          console.log(chalk.bold('═'.repeat(60)));
          console.log(chalk.green.bold('✓ WORKFLOW COMPLETED'));
          console.log(chalk.bold('═'.repeat(60)));
          console.log('');
          
          // Render markdown output
          const output = data.output || 'No output';
          try {
            const rendered = marked.parse(output) as string;
            console.log(rendered);
          } catch {
            // Fallback to plain text if markdown parsing fails
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
      }
    }

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
