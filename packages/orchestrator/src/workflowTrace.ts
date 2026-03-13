import { getDb } from '@orchestrator/shared';
import type { WorkflowStepType, WorkflowTraceStep } from '@orchestrator/shared';

const stringifyMaybe = (value: unknown): string | null => {
  if (value === undefined) return null;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
};

export const logWorkflowStep = (input: {
  workflow_id: string;
  step_type: WorkflowStepType;
  model_name?: string | null;
  message_content?: string | null;
  tool_name?: string | null;
  tool_input?: unknown;
  tool_output?: unknown;
  subagent_id?: string | null;
  timestamp?: string;
}): WorkflowTraceStep => {
  const db = getDb();
  const step: WorkflowTraceStep = {
    step_id: crypto.randomUUID(),
    workflow_id: input.workflow_id,
    timestamp: input.timestamp ?? new Date().toISOString(),
    step_type: input.step_type,
    model_name: input.model_name ?? null,
    message_content: input.message_content ?? null,
    tool_name: input.tool_name ?? null,
    tool_input: input.tool_input ?? null,
    tool_output: input.tool_output ?? null,
    subagent_id: input.subagent_id ?? null,
  };

  db.prepare(
    `INSERT INTO workflow_steps (
      id, workflow_id, step_id, timestamp, step_type, model_name,
      message_content, tool_name, tool_input, tool_output, subagent_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    crypto.randomUUID(),
    step.workflow_id,
    step.step_id,
    step.timestamp,
    step.step_type,
    step.model_name,
    step.message_content,
    step.tool_name,
    stringifyMaybe(step.tool_input),
    stringifyMaybe(step.tool_output),
    step.subagent_id
  );

  return step;
};

const parseMaybeJson = (value: unknown): unknown => {
  if (typeof value !== 'string' || value.length === 0) {
    return value ?? null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

export const getWorkflowTrace = (workflowId: string): WorkflowTraceStep[] => {
  const db = getDb();
  const rows = db.prepare(
    `SELECT step_id, workflow_id, timestamp, step_type, model_name, message_content,
            tool_name, tool_input, tool_output, subagent_id
     FROM workflow_steps
     WHERE workflow_id = ?
     ORDER BY timestamp ASC, created_at ASC`
  ).all(workflowId) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    step_id: row['step_id'] as string,
    workflow_id: row['workflow_id'] as string,
    timestamp: row['timestamp'] as string,
    step_type: row['step_type'] as WorkflowStepType,
    model_name: (row['model_name'] as string) ?? null,
    message_content: (row['message_content'] as string) ?? null,
    tool_name: (row['tool_name'] as string) ?? null,
    tool_input: parseMaybeJson(row['tool_input']),
    tool_output: parseMaybeJson(row['tool_output']),
    subagent_id: (row['subagent_id'] as string) ?? null,
  }));
};
