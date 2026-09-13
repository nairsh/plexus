import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  getErrorMessage,
  logger,
  openTerminalFetchJson,
  registerFileInIndex,
  SandboxError,
} from '@orchestrator/shared';
import { checkFileLint, formatLintResultsForAgent } from '../linting.js';
import { isLocalWorkspace, resolveWorkspacePath } from './paths.js';
import type { FileEditResult, FileReadResult, FileWriteResult, WorkspaceSession } from './types.js';

export async function executeReadFile(
  session: WorkspaceSession,
  filePath: string,
  limit?: number,
  offset?: number
): Promise<FileReadResult> {
  try {
    if (isLocalWorkspace(session)) {
      const fullPath = resolveWorkspacePath(session, filePath);
      const stats = statSync(fullPath, { throwIfNoEntry: false });
      if (!stats) {
        throw new SandboxError(`File not found: ${filePath}`, 'file_read_failed');
      }

      if (stats.isDirectory()) {
        return {
          path: filePath,
          isDirectory: true,
          entries: readdirSync(fullPath),
          content: '',
        };
      }

      const content = readFileSync(fullPath, 'utf-8');
      const lines = content.split('\n');
      const start = Math.max(0, (offset ?? 1) - 1);
      const end = limit ? start + limit : undefined;
      return {
        path: filePath,
        content: lines.slice(start, end).join('\n'),
      };
    }

    // Try to read as file first
    const response = await fetch(
      `${session.baseUrl}/files/read?path=${encodeURIComponent(filePath)}${limit ? `&limit=${limit}` : ''}${offset ? `&offset=${offset}` : ''}`,
      {
        headers: { Authorization: `Bearer ${session.apiKey}` },
        signal: AbortSignal.timeout(15_000),
      }
    );

    if (response.ok) {
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('application/json')) {
        const body = (await response.json()) as { content?: string; entries?: Array<{ name: string; type: string }> };
        if (body.entries) {
          return {
            path: filePath,
            isDirectory: true,
            entries: body.entries.map((e) => e.name),
            content: '',
          };
        }
        return {
          path: filePath,
          content: body.content ?? '',
        };
      }
      return {
        path: filePath,
        content: Buffer.from(await response.arrayBuffer()).toString('utf-8'),
      };
    }

    // If file read fails, try listing directory
    if (response.status === 404 || response.status === 400) {
      const listResponse = await openTerminalFetchJson<{ entries: Array<{ name: string; type: string }> }>(
        session,
        `/files/list?directory=${encodeURIComponent(filePath)}`
      );
      return {
        path: filePath,
        isDirectory: true,
        entries: listResponse.entries.map((e) => e.name),
        content: '',
      };
    }

    throw new SandboxError(`Failed to read ${filePath}: ${response.statusText}`, 'file_read_failed');
  } catch (err) {
    logger.error({ path: filePath, error: getErrorMessage(err) }, 'Failed to read file');
    throw err;
  }
}

export async function executeWriteFile(
  session: WorkspaceSession,
  filePath: string,
  content: string,
  runLint = true
): Promise<FileWriteResult> {
  try {
    if (isLocalWorkspace(session)) {
      const fullPath = resolveWorkspacePath(session, filePath);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, content, 'utf-8');
    } else {
      await openTerminalFetchJson(session, '/files/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath, content }),
      });
    }

    const bytesWritten = Buffer.byteLength(content, 'utf-8');
    const result: FileWriteResult = { path: filePath, bytes_written: bytesWritten };

    // Auto-lint after write for TypeScript/JS/Python files
    if (runLint) {
      const lintResult = await checkFileLint(session, filePath);
      if (lintResult.language !== 'unknown') {
        result.lint = {
          errors: lintResult.errors.length,
          warnings: lintResult.warnings.length,
          summary: formatLintResultsForAgent([lintResult]),
        };
      }
    }

    return result;
  } catch (err) {
    logger.error({ path: filePath, error: getErrorMessage(err) }, 'Failed to write file');
    throw err;
  }
}

export async function executeEditFile(
  session: WorkspaceSession,
  filePath: string,
  oldString: string,
  newString: string
): Promise<FileEditResult> {
  try {
    // Read file first — required before any edit
    const readResult = await executeReadFile(session, filePath);
    const currentContent = readResult.content;

    // Check if oldString exists exactly
    if (!currentContent.includes(oldString)) {
      throw new SandboxError(
        `oldString not found in file. The file may have changed or the string may be incorrect.`,
        'edit_oldstring_not_found'
      );
    }

    // Count occurrences to warn about multiple matches
    const occurrences = currentContent.split(oldString).length - 1;
    if (occurrences > 1) {
      logger.warn({ path: filePath, occurrences }, 'Multiple occurrences of oldString found, replacing all');
    }

    // Replace all occurrences
    const newContent = currentContent.replaceAll(oldString, newString);

    // Write the updated content — pass runLint=false so we control lint below
    await executeWriteFile(session, filePath, newContent, false);

    // Run lint on the edited file
    const lintResult = await checkFileLint(session, filePath);
    const lintSummary =
      lintResult.language !== 'unknown'
        ? {
            errors: lintResult.errors.length,
            warnings: lintResult.warnings.length,
            summary: formatLintResultsForAgent([lintResult]),
          }
        : undefined;

    return {
      path: filePath,
      success: true,
      oldString,
      newString,
      lint: lintSummary,
    };
  } catch (err) {
    logger.error({ path: filePath, error: getErrorMessage(err) }, 'Failed to edit file');
    throw err;
  }
}
