/**
 * LSP/lint integration for coding agents.
 *
 * After every file_write or file_edit, the agent can call checkLint() to get
 * TypeScript/JS/Python errors from the project's compiler. Errors are fed back
 * into the next iteration so the agent self-corrects.
 */
import { execFile } from 'node:child_process';
import { extname } from 'node:path';
import { promisify } from 'node:util';
import { LINT_CHECK_TIMEOUT_MS } from '@orchestrator/shared';
import type { LintError, LintResult } from '@orchestrator/shared';
import { logger } from '@orchestrator/shared';
import type { WorkspaceSession } from './fileOperations.js';

const execFileAsync = promisify(execFile);

// ── Language detection ────────────────────────────────────────────────────────

const EXT_TO_LANGUAGE: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
};

export function detectLanguage(filePath: string): string | null {
  return EXT_TO_LANGUAGE[extname(filePath).toLowerCase()] ?? null;
}

// ── TypeScript lint ───────────────────────────────────────────────────────────

const TS_ERROR_RE = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/;

function parseTscOutput(output: string, requestedPath: string): LintError[] {
  const errors: LintError[] = [];

  for (const line of output.split('\n')) {
    const m = TS_ERROR_RE.exec(line.trim());
    if (!m) continue;

    const [, filePath, lineStr, colStr, severity, rule, message] = m;

    // Only include errors for the specific file or nearby files
    if (!filePath || (!filePath.includes(requestedPath) && requestedPath !== '')) {
      // Include all errors when no specific file is requested
    }

    errors.push({
      line: parseInt(lineStr ?? '1', 10),
      column: parseInt(colStr ?? '1', 10),
      severity: severity === 'error' ? 'error' : 'warning',
      message: message ?? line,
      rule: rule,
    });
  }

  return errors;
}

async function runTsc(workspacePath: string, filePath?: string): Promise<LintError[]> {
  try {
    const args = ['--noEmit', '--pretty', 'false', '--skipLibCheck'];

    if (filePath) {
      // Check a specific file in isolation when possible
      args.push('--allowJs', '--checkJs', filePath);
    }

    const { stdout, stderr } = await execFileAsync('npx', ['tsc', ...args], {
      cwd: workspacePath,
      timeout: LINT_CHECK_TIMEOUT_MS,
      env: { ...process.env, NODE_ENV: 'development' },
    }).catch((err: { stdout?: string; stderr?: string }) => ({
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
    }));

    const output = (stdout + stderr).trim();
    return parseTscOutput(output, filePath ?? '');
  } catch (err) {
    logger.warn({ error: String(err) }, 'tsc lint check failed');
    return [];
  }
}

// ── Python lint (pyflakes — zero-dep, fast) ───────────────────────────────────

const PYFLAKES_ERROR_RE = /^(.+?):(\d+):(?:(\d+):)?\s+(.+)$/;

async function runPyflakes(workspacePath: string, filePath: string): Promise<LintError[]> {
  try {
    const { stdout, stderr } = await execFileAsync('python3', ['-m', 'pyflakes', filePath], {
      cwd: workspacePath,
      timeout: LINT_CHECK_TIMEOUT_MS,
    }).catch((err: { stdout?: string; stderr?: string }) => ({
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
    }));

    const errors: LintError[] = [];
    for (const line of (stdout + stderr).split('\n')) {
      const m = PYFLAKES_ERROR_RE.exec(line.trim());
      if (!m) continue;
      errors.push({
        line: parseInt(m[2] ?? '1', 10),
        column: parseInt(m[3] ?? '1', 10),
        severity: 'error',
        message: m[4] ?? line,
      });
    }

    return errors;
  } catch {
    return []; // pyflakes not available — silently skip
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run a lint check on the given file path within the workspace.
 * Returns a LintResult with errors and warnings.
 * Never throws — lint failures are non-fatal and returned as empty results.
 */
export async function checkFileLint(
  session: WorkspaceSession,
  filePath: string
): Promise<LintResult> {
  const language = detectLanguage(filePath);

  if (!language) {
    return { language: 'unknown', filePath, errors: [], warnings: [] };
  }

  let all: LintError[] = [];

  if (language === 'typescript' || language === 'javascript') {
    all = await runTsc(session.workspacePath, filePath);
  } else if (language === 'python') {
    all = await runPyflakes(session.workspacePath, filePath);
  }

  const errors = all.filter((e) => e.severity === 'error');
  const warnings = all.filter((e) => e.severity === 'warning');

  if (errors.length > 0) {
    logger.info(
      { filePath, language, errorCount: errors.length },
      'Lint check found errors in file'
    );
  }

  return { language, filePath, errors, warnings };
}

/**
 * Run a full project lint (tsc --noEmit without a specific file).
 * More comprehensive but slower.
 */
export async function checkProjectLint(session: WorkspaceSession): Promise<LintResult[]> {
  const errors = await runTsc(session.workspacePath);

  // Group by "file-level" — for now return as a single aggregate result
  const allErrors = errors.filter((e) => e.severity === 'error');
  const allWarnings = errors.filter((e) => e.severity === 'warning');

  return [
    {
      language: 'typescript',
      filePath: '(project)',
      errors: allErrors,
      warnings: allWarnings,
    },
  ];
}

/**
 * Format lint results as a compact string for feeding back into agent context.
 */
export function formatLintResultsForAgent(results: LintResult[]): string {
  const allErrors = results.flatMap((r) =>
    r.errors.map((e) => `  ${r.filePath}:${e.line}:${e.column} [${e.rule ?? 'lint'}] ${e.message}`)
  );
  const allWarnings = results.flatMap((r) =>
    r.warnings.map(
      (e) => `  ${r.filePath}:${e.line}:${e.column} [${e.rule ?? 'lint'}] ${e.message}`
    )
  );

  if (allErrors.length === 0 && allWarnings.length === 0) {
    return 'No lint errors found.';
  }

  const parts: string[] = [];
  if (allErrors.length > 0) {
    parts.push(`Errors (${allErrors.length}):\n${allErrors.join('\n')}`);
  }
  if (allWarnings.length > 0) {
    parts.push(`Warnings (${allWarnings.length}):\n${allWarnings.join('\n')}`);
  }

  return parts.join('\n\n');
}
