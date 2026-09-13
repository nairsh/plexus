/**
 * Barrel re-export for tool definitions, schema builders, approval logic, and executor.
 * Import from here for backward compatibility.
 */
export type { CanonicalToolDefinition, ToolCallResult, ToolParameters } from './defs.js';
export {
  BUILTIN_TOOL_NAMES,
  CANONICAL_TOOL_DEFS,
  buildAnthropicTools,
  buildGoogleTools,
  buildOpenAITools,
} from './defs.js';
export { getCommandApprovalReason, requestCommandApproval } from './approval.js';
export { executeToolCall } from './executor.js';
