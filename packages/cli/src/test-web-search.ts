#!/usr/bin/env node
/**
 * Web Search Tool Test CLI
 *
 * Usage:
 *   pnpm test-web-search "What is the latest news on AI?"
 *   pnpm test-web-search "test query" --model litellm/gemini-3.1-flash-lite-preview
 */

import { config } from 'dotenv';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

// Load environment variables from .env file
// Try to find .env from the monorepo root (2 levels up from this file)
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const envPath = resolve(__dirname, '../../../.env');
config({ path: envPath });

import { program } from 'commander';
import { searchWeb, TavilySearchResponse } from '@orchestrator/model-router';
import chalk from 'chalk';
import ora from 'ora';

program
  .name('test-web-search')
  .description('CLI tool for testing the web search tool')
  .argument('[query]', 'Search query to execute')
  .option('-m, --model <model>', 'Model to use (for logging purposes)', 'litellm/gemini-3.1-flash-lite-preview')
  .option('-v, --verbose', 'Show verbose output')
  .parse();

const options = program.opts();
const [query] = program.args;

if (!query) {
  console.error(chalk.red('\n❌ Error: Search query is required'));
  console.log(chalk.dim('\nUsage: pnpm test-web-search "Your search query"'));
  console.log('');
  process.exit(1);
}

async function main() {
  console.log(chalk.bold('\n🔍 Web Search Tool Test\n'));
  console.log(chalk.dim('Query:'), chalk.white(query));
  console.log(chalk.dim('Model:'), chalk.cyan(options.model));
  console.log(chalk.dim('Provider:'), chalk.cyan('Tavily API (with public fallback)'));
  console.log(chalk.dim('TAVILY_API_KEY loaded:'), process.env.TAVILY_API_KEY ? chalk.green('Yes') : chalk.red('No'));
  console.log('');

  const spinner = ora({
    text: 'Executing web search...',
    spinner: 'dots',
    color: 'cyan',
  }).start();

  try {
    const startTime = Date.now();
    const result: TavilySearchResponse = await searchWeb(query);
    const duration = Date.now() - startTime;

    spinner.succeed(`Search completed in ${duration}ms`);
    console.log('');

    // Display results
    console.log(chalk.bold('─'.repeat(60)));
    console.log(chalk.bold('SEARCH RESULTS'));
    console.log(chalk.bold('─'.repeat(60)));
    console.log('');

    console.log(
      chalk.dim('Provider:'),
      result.provider === 'tavily' ? chalk.green('Tavily API') : chalk.yellow('Public Fallback (DuckDuckGo)')
    );
    console.log(chalk.dim('Query:'), chalk.white(result.query));

    if (result.answer) {
      console.log(chalk.dim('Answer:'), chalk.white(result.answer));
    }

    console.log(chalk.dim('Results:'), chalk.white(result.results.length));
    console.log('');

    // Display each result
    result.results.forEach((r: TavilySearchResponse['results'][number], i: number) => {
      console.log(chalk.bold(`${i + 1}. ${r.title}`));
      console.log(chalk.dim('   URL:'), chalk.blue.underline(r.url));
      console.log(
        chalk.dim('   Snippet:'),
        chalk.gray(r.snippet.substring(0, 150) + (r.snippet.length > 150 ? '...' : ''))
      );
      if (r.score !== undefined) {
        console.log(chalk.dim('   Score:'), chalk.yellow(r.score.toFixed(3)));
      }
      console.log('');
    });

    // Summary
    console.log(chalk.bold('─'.repeat(60)));
    console.log(chalk.green.bold('✅ Web search test completed successfully'));
    console.log(chalk.bold('─'.repeat(60)));
    console.log('');
    console.log(chalk.dim('Provider:'), result.provider);
    console.log(chalk.dim('Results count:'), result.results.length);
    console.log(chalk.dim('Duration:'), `${duration}ms`);
    console.log('');
  } catch (error) {
    spinner.stop();
    console.error(chalk.red('\n❌ Web search failed:'), error instanceof Error ? error.message : String(error));

    if (options.verbose && error instanceof Error) {
      console.error(chalk.gray('\nStack trace:'));
      console.error(chalk.gray(error.stack));
    }

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
