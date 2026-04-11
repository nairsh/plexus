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
  getAuthToken?: () => Promise<string | null>;
  hasAuth?: boolean;
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

function normalizeApiErrorMessage(message: string): string {
  const lowered = message.toLowerCase();
  if (
    lowered.includes('invalid api key') ||
    lowered.includes('invalid or missing api key') ||
    lowered.includes('invalid or expired clerk token') ||
    lowered.includes('invalid auth token') ||
    lowered.includes('missing authentication token')
  ) {
    return 'Sign in with Clerk to continue.';
  }
  return message;
}

async function request<T>(config: ApiConfig, path: string, init?: RequestInit): Promise<T> {
  const url = `${config.baseUrl.replace(/\/$/, '')}${path}`;
  const headers = new Headers(init?.headers);
  if (!headers.has('Accept')) headers.set('Accept', 'application/json');
  if (init?.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  const token = await resolveAuthToken(config);
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const response = await fetch(url, {
    ...init,
    headers,
  });

  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      message = body.error?.message ?? message;
    } catch {
      // ignore parse failure
    }
    throw new ApiError(response.status, normalizeApiErrorMessage(message));
  }

  return response.json() as Promise<T>;
}

async function resolveAuthToken(config: ApiConfig): Promise<string | null> {
  const clerkToken = config.getAuthToken ? await config.getAuthToken() : null;
  if (clerkToken && clerkToken.trim().length > 0) {
    return clerkToken.trim();
  }
  return null;
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
  await request(config, `/v1/workflows/${workflowId}/cancel`, { method: 'POST' });
}

export async function getWorkflowDetails(config: ApiConfig, workflowId: string): Promise<WorkflowDetails> {
  return request<WorkflowDetails>(config, `/v1/workflows/${workflowId}`);
}

export async function checkHealth(config: ApiConfig): Promise<{ status: string }> {
  return request<{ status: string }>(config, '/health');
}
