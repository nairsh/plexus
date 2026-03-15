import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export interface PromptVariables {
  [key: string]: string | number | boolean | object;
}

/**
 * Load a prompt from a markdown file and interpolate variables.
 * 
 * Variables use {{variableName}} syntax.
 * Objects are automatically JSON-stringified with indentation.
 * 
 * Example:
 *   loadPrompt('orchestrator.md', { tools: ['tool1', 'tool2'], mode: 'direct' })
 * 
 * @param filename - Name of the markdown file in the prompts directory
 * @param variables - Variables to interpolate
 * @returns The interpolated prompt string
 */
export function loadPrompt(filename: string, variables: PromptVariables = {}): string {
  const filepath = resolve(__dirname, 'prompts', filename);
  let content: string;
  
  try {
    content = readFileSync(filepath, 'utf-8');
  } catch (error) {
    throw new Error(`Failed to load prompt file: ${filepath}. ${(error as Error).message}`);
  }
  
  return interpolateVariables(content, variables);
}

/**
 * Interpolate {{variableName}} placeholders in content.
 */
function interpolateVariables(content: string, variables: PromptVariables): string {
  return content.replace(/\{\{(\w+)\}\}/g, (match, varName) => {
    const value = variables[varName];
    
    if (value === undefined || value === null) {
      console.warn(`Warning: Prompt variable '${varName}' not provided`);
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

/**
 * Format tools for prompt display.
 */
export function formatToolsForPrompt(tools: Array<{ name: string; description: string; parameters?: object }>): string {
  return tools.map(tool => {
    let lines = [`- ${tool.name}: ${tool.description}`];
    if (tool.parameters && Object.keys(tool.parameters).length > 0) {
      lines.push(`  Parameters: ${JSON.stringify(tool.parameters, null, 2).replace(/\n/g, '\n  ')}`);
    }
    return lines.join('\n');
  }).join('\n');
}

/**
 * Format work items for prompt display.
 */
export function formatWorkItemsForPromptSection(workItems: Array<{ id: string; description: string; agent_type: string; status: string; depends_on?: string[] }>): string {
  if (workItems.length === 0) {
    return 'No work items.';
  }
  
  return workItems.map(item => {
    const deps = item.depends_on && item.depends_on.length > 0 
      ? ` (depends on: ${item.depends_on.join(', ')})`
      : '';
    return `- [${item.status}] ${item.id}: ${item.description} (${item.agent_type})${deps}`;
  }).join('\n');
}

/**
 * Format conversation history for prompt display.
 */
export function formatConversationHistory(messages: Array<{ role: string; content: string; timestamp?: string }>): string {
  if (messages.length === 0) {
    return 'No previous conversation.';
  }
  
  return messages.map(msg => {
    const timestamp = msg.timestamp ? ` [${msg.timestamp}]` : '';
    return `${msg.role.toUpperCase()}${timestamp}:\n${msg.content}`;
  }).join('\n\n---\n\n');
}
