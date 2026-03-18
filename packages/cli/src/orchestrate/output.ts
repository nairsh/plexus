import { Marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import chalk from 'chalk';
import type { WorkflowSummary } from '@orchestrator/orchestrator';
import { getModelInfo } from '@orchestrator/model-router';

const marked = new Marked({
  gfm: true,
  breaks: true,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(marked as any).use(
  markedTerminal({
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
  })
);

export interface CommandResult {
  output?: string;
  credits?: number;
  error?: string;
  workflowId?: string;
}

export const printAsciiLogo = (title: string): void => {
  const logo = chalk.white(
    [
      '',
      '   ▄██████████████████▄',
      '   ██                ██',
      '   ██    ██    ██    ██',
      '   ██    ██    ██    ██',
      '   ██                ██',
      '   ▀██████████████████▀',
      '   ████████████████████',
      '',
    ].join('\n')
  );

  console.log(logo);
  console.log(chalk.white.bold(`   ${title}\n`));
};

export const prettifyModelLabel = (modelId: string): string => {
  const modelInfo = getModelInfo(modelId);
  if (modelInfo?.display_name) {
    return modelInfo.display_name.replace(/\s*\(via LiteLLM\)$/i, '');
  }

  const short = modelId.includes('/') ? (modelId.split('/').pop() ?? modelId) : modelId;
  return short
    .replace(/^ali-/i, '')
    .replace(/^openai-/i, '')
    .replace(/^anthropic-/i, '')
    .replace(/^google-/i, '')
    .replace(/^gemini-/i, 'Gemini-')
    .replace(/^gpt-/i, 'GPT-')
    .replace(/^claude-/i, 'Claude-')
    .replace(/^minimax-/i, 'MiniMax-')
    .replace(/^deepseek-/i, 'DeepSeek-');
};

export const renderOutputText = (output: string): void => {
  try {
    const rendered = marked.parse(output) as string;
    console.log(rendered);
  } catch {
    console.log(chalk.white(output));
  }
};

export const formatJsonOutput = (result: CommandResult): string => {
  return JSON.stringify(
    {
      success: !result.error,
      output: result.output,
      credits: result.credits,
      error: result.error,
      workflowId: result.workflowId,
    },
    null,
    2
  );
};

export const saveOutputToFile = async (filePath: string, content: string): Promise<void> => {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(filePath, content, 'utf-8');
};

export const toHistoryOptions = (workflows: WorkflowSummary[]) => {
  return workflows.slice(0, 20).map((workflow) => ({
    id: workflow.id,
    objective: workflow.objective,
    status: workflow.status,
    updated_at: workflow.updated_at,
    created_at: workflow.created_at,
  }));
};
