import type { CreateWorkflowResponse, Workflow } from './types.js';

interface WorkflowDetailsTask {
  task_id: string;
  description: string;
  agent_type: string;
  status: string;
  created_at?: string;
}

interface WorkflowDetails {
  workflow: Workflow;
  tasks: WorkflowDetailsTask[];
}

export interface ApiConfig {
  baseUrl: string;
  apiKey: string;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(config: ApiConfig, path: string, init?: RequestInit): Promise<T> {
  const url = `${config.baseUrl.replace(/\/$/, '')}${path}`;
  const response = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
      ...init?.headers,
    },
  });

  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      message = body.error?.message ?? message;
    } catch {
      // ignore parse failure
    }
    throw new ApiError(response.status, message);
  }

  return response.json() as Promise<T>;
}

export async function createWorkflow(config: ApiConfig, objective: string): Promise<CreateWorkflowResponse> {
  return request<CreateWorkflowResponse>(config, '/v1/workflows', {
    method: 'POST',
    body: JSON.stringify({ objective }),
  });
}

export async function listWorkflows(
  config: ApiConfig,
  status?: string
): Promise<{ workflows: Workflow[]; total: number }> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : '';
  return request<{ workflows: Workflow[]; total: number }>(config, `/v1/workflows${qs}`);
}

export async function cancelWorkflow(config: ApiConfig, workflowId: string): Promise<void> {
  await request(config, `/v1/workflows/${workflowId}`, { method: 'DELETE' });
}

export async function getWorkflowDetails(config: ApiConfig, workflowId: string): Promise<WorkflowDetails> {
  return request<WorkflowDetails>(config, `/v1/workflows/${workflowId}`);
}

export async function checkHealth(config: ApiConfig): Promise<{ status: string }> {
  return request<{ status: string }>(config, '/health');
}
