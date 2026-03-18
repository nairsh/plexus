import type { WorkflowSummary } from '@orchestrator/orchestrator';
import { continueWorkflow, executeWorkflow, getWorkflowDetails, planWorkflow } from '@orchestrator/orchestrator';
import type { CommandResult } from './output.js';
import { renderOutputText, saveOutputToFile } from './output.js';
import { streamWorkflow } from './workflow-stream.js';
import chalk from 'chalk';
import ora from 'ora';

interface NonInteractiveOptions {
  objective: string;
  continueWorkflowId?: string;
  model: string;
  userId: string;
  maxCredits: string;
  stream: boolean;
  json: boolean;
  output?: string;
  spinner: ReturnType<typeof ora>;
}

const printFinalResult = (
  details: { workflow: WorkflowSummary; tasks: Array<{ description: string; status: string }> } | null,
  result: CommandResult
): void => {
  console.log(`\n${chalk.bold('═'.repeat(60))}`);
  console.log(chalk.bold('FINAL OUTPUT'));
  console.log(chalk.bold('═'.repeat(60)));

  if (result.output) {
    renderOutputText(result.output);
  } else if (details?.tasks?.length) {
    console.log(details.tasks.map((task) => `• ${task.description} [${task.status}]`).join('\n'));
  } else {
    console.log('No output');
  }

  console.log('');
  if (result.credits !== undefined) {
    console.log(chalk.dim(`Credits used: ${result.credits.toFixed(4)}`));
  }
  console.log('');
};

export const runNonInteractive = async (options: NonInteractiveOptions): Promise<CommandResult> => {
  let workflowId: string;

  if (options.continueWorkflowId) {
    options.spinner.start('Continuing workflow...');
    await continueWorkflow(options.continueWorkflowId, options.objective);
    workflowId = options.continueWorkflowId;
    options.spinner.succeed(`Workflow continued: ${chalk.cyan(workflowId.substring(0, 8))}`);
  } else {
    options.spinner.start('Starting workflow...');
    const planResult = await planWorkflow(options.userId, {
      objective: options.objective,
      orchestrator_model: options.model,
      max_credits: Number.parseFloat(options.maxCredits),
    });
    workflowId = planResult.workflowId;
    options.spinner.succeed(`Workflow started: ${chalk.cyan(workflowId.substring(0, 8))}`);
  }

  if (!options.json) {
    console.log('');
  }

  let result: CommandResult;
  if (!options.stream) {
    options.spinner.start('Executing workflow...');
    const stream = executeWorkflow(workflowId);
    await stream.done;
    options.spinner.stop();

    const details = getWorkflowDetails(workflowId);
    result = {
      workflowId,
      output: details?.workflow?.output ?? undefined,
      credits: details?.workflow?.credits_consumed,
    };

    if (!options.json) {
      printFinalResult(details, result);
    }
  } else {
    result = { workflowId, ...(await streamWorkflow(workflowId)) };
  }

  if (options.output && result.output) {
    await saveOutputToFile(options.output, result.output);
    if (!options.json) {
      console.log(chalk.green(`✓ Output saved to ${options.output}`));
    }
  }

  return result;
};
