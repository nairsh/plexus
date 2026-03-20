import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getErrorMessage, logger } from '@orchestrator/shared';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export interface PromptVariables {
  [key: string]: string | number | boolean | object;
}

export interface PromptRuntimeContext {
  currentDate: string;
  currentTime: string;
  currentDateTime: string;
  currentTimezone: string;
  nowIso: string;
  modelBackend: string;
}

export function loadPrompt(filename: string, variables: PromptVariables = {}): string {
  const filepath = resolve(__dirname, 'prompts', filename);
  let content: string;
  
  try {
    content = readFileSync(filepath, 'utf-8');
  } catch (error) {
    throw new Error(`Failed to load prompt file: ${filepath}. ${getErrorMessage(error)}`);
  }
  
  return interpolateVariables(content, variables);
}

export function getPromptRuntimeContext(now: Date = new Date()): PromptRuntimeContext {
  const currentTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  return {
    currentDate: now.toLocaleDateString('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      timeZone: currentTimezone,
    }),
    currentTime: now.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
      timeZone: currentTimezone,
    }),
    currentDateTime: now.toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
      timeZone: currentTimezone,
    }),
    currentTimezone,
    nowIso: now.toISOString(),
    modelBackend: 'LiteLLM',
  };
}

function interpolateVariables(content: string, variables: PromptVariables): string {
  return content.replace(/\{\{(\w+)\}\}/g, (match, varName) => {
    const value = variables[varName];
    
    if (value === undefined || value === null) {
      logger.warn({ varName }, `Prompt variable '${varName}' not provided`);
      return match; // Keep original placeholder
    }
    
    // Format based on type
    if (typeof value === 'string') {
      return value;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    } else if (typeof value === 'object') {
      // Pretty print objects (arrays, objects)
      return JSON.stringify(value, null, 2);
    }
    
    return String(value);
  });
}

export function formatConversationHistory(messages: Array<{ role: string; content: string; timestamp?: string }>): string {
  if (messages.length === 0) {
    return 'No previous conversation.';
  }
  
  return messages.map(msg => {
    const timestamp = msg.timestamp ? ` [${msg.timestamp}]` : '';
    return `${msg.role.toUpperCase()}${timestamp}:\n${msg.content}`;
  }).join('\n\n---\n\n');
}
