/**
 * Connection testing utilities for LiteLLM and Tavily.
 */

import { existsSync, accessSync, constants, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logger } from '@orchestrator/shared';

export interface ConnectionTestResult {
  success: boolean;
  latency?: number;
  error?: string;
  hint?: string;
  data?: unknown;
}

/**
 * Test LiteLLM connection by listing models.
 */
export async function testLiteLLMConnection(baseUrl: string, apiKey: string): Promise<ConnectionTestResult> {
  const startTime = Date.now();

  try {
    const url = new URL('/v1/models', baseUrl);
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(10000), // 10 second timeout
    });

    const latency = Date.now() - startTime;

    if (response.status === 401) {
      return {
        success: false,
        latency,
        error: 'Authentication failed',
        hint: 'Check that your LITELLM_API_KEY is correct.',
      };
    }

    if (response.status === 404) {
      return {
        success: false,
        latency,
        error: 'Endpoint not found',
        hint: `${baseUrl} does not appear to be a LiteLLM instance.`,
      };
    }

    if (!response.ok) {
      return {
        success: false,
        latency,
        error: `HTTP ${response.status}: ${response.statusText}`,
        hint: 'Check that LiteLLM is running and accessible.',
      };
    }

    const data = (await response.json()) as { data?: Array<{ id: string }> };
    const models = data.data ?? [];

    logger.debug({ modelCount: models.length, latency }, 'LiteLLM connection successful');

    return {
      success: true,
      latency,
      data: models.map((m) => m.id),
    };
  } catch (error) {
    const latency = Date.now() - startTime;
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes('timeout') || message.includes('ECONNREFUSED') || message.includes('ENOTFOUND')) {
      return {
        success: false,
        latency,
        error: `Could not reach LiteLLM at ${baseUrl}`,
        hint: 'Is the LiteLLM server running? Check the URL and network connectivity.',
      };
    }

    return {
      success: false,
      latency,
      error: message,
      hint: 'An unexpected error occurred while connecting to LiteLLM.',
    };
  }
}

/**
 * Fetch available models from LiteLLM.
 */
export async function fetchLiteLLMModels(baseUrl: string, apiKey: string): Promise<string[]> {
  const result = await testLiteLLMConnection(baseUrl, apiKey);

  if (!result.success) {
    throw new Error(result.error);
  }

  return (result.data as string[]) ?? [];
}

/**
 * Test Tavily API connection.
 */
export async function testTavilyConnection(apiKey: string): Promise<ConnectionTestResult> {
  const startTime = Date.now();

  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: 'test',
        max_results: 1,
      }),
      signal: AbortSignal.timeout(10000),
    });

    const latency = Date.now() - startTime;

    if (response.status === 401) {
      return {
        success: false,
        latency,
        error: 'Invalid API key',
        hint: 'Check that your TAVILY_API_KEY is correct.',
      };
    }

    if (!response.ok) {
      return {
        success: false,
        latency,
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    return {
      success: true,
      latency,
    };
  } catch (error) {
    const latency = Date.now() - startTime;
    const message = error instanceof Error ? error.message : String(error);

    return {
      success: false,
      latency,
      error: message,
    };
  }
}

/**
 * Test database connection and permissions.
 */
export function testDatabaseConnection(dbPath: string): ConnectionTestResult {
  try {
    if (!existsSync(dbPath)) {
      // Check if parent directory exists and is writable
      const parentDir = dirname(dbPath);
      if (!existsSync(parentDir)) {
        try {
          mkdirSync(parentDir, { recursive: true });
        } catch {
          return {
            success: false,
            error: 'Database directory does not exist and cannot be created',
            hint: `Create the directory: mkdir -p ${parentDir}`,
          };
        }
      }

      return {
        success: true,
        hint: 'Database will be created on first run',
      };
    }

    accessSync(dbPath, constants.R_OK | constants.W_OK);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      hint: 'Check file permissions on the database file.',
    };
  }
}

/**
 * Test write permissions for a directory.
 */
export function testDirectoryWritable(dirPath: string): ConnectionTestResult {
  try {
    if (!existsSync(dirPath)) {
      try {
        mkdirSync(dirPath, { recursive: true });
      } catch {
        return {
          success: false,
          error: 'Directory does not exist and cannot be created',
        };
      }
    }

    // Try writing a test file
    const testFile = join(dirPath, '.write-test');
    writeFileSync(testFile, 'test');
    unlinkSync(testFile);

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      hint: 'Check directory permissions.',
    };
  }
}
