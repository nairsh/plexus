/**
 * Zod schemas for SQLite DB row types and a parseRow() helper.
 * Use these instead of bare `as RowType` casts to get runtime validation.
 */
import { z } from 'zod';

/** Parse a DB row with a Zod schema. Throws ZodError on mismatch. */
export function parseRow<T>(schema: z.ZodType<T>, row: unknown): T {
  return schema.parse(row);
}

/** Parse a possibly-undefined DB row. Returns null if row is undefined. */
export function parseRowOrNull<T>(schema: z.ZodType<T>, row: unknown): T | null {
  if (row === undefined || row === null) return null;
  return schema.parse(row);
}

// ── Task row ──

export const TaskRowSchema = z.object({
  id: z.string(),
  workflow_id: z.string(),
  description: z.string().nullable(),
  task_type: z.string(),
  parent_task_ids: z.string(),
  status: z.string(),
  output: z.string().nullable(),
  model: z.string().nullable(),
  tools: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
});
export type TaskRow = z.infer<typeof TaskRowSchema>;

// ── Workflow row ──

export const WorkflowRowSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  objective: z.string(),
  orchestrator_model: z.string().nullable(),
  status: z.string(),
  config: z.string().nullable(),
  credits_consumed: z.number().nullable(),
});
export type WorkflowRow = z.infer<typeof WorkflowRowSchema>;

// ── Sandbox session row ──

export const SandboxSessionRowSchema = z.object({
  id: z.string(),
  open_terminal_url: z.string().nullable(),
  open_terminal_api_key: z.string().nullable(),
  chat_id: z.string(),
  status: z.string(),
  environment_status: z.string(),
  working_dir: z.string().nullable(),
  workspace_path: z.string().nullable(),
});
export type SandboxSessionRow = z.infer<typeof SandboxSessionRowSchema>;
