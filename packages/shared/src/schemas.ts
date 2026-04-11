import { z } from 'zod';

// ── Tool schemas ──
export const ToolSchema = z.object({
  type: z.enum([
    'web_search',
    'fetch_url',
    'function',
    'code_execution',
    'file_read',
    'file_write',
    'file_edit',
    'bash',
    'grep',
    'glob',
    'run_skill',
    'remember',
    'recall',
    'search_knowledge',
  ]),
  function: z
    .object({
      name: z.string(),
      description: z.string(),
      parameters: z.record(z.unknown()),
    })
    .optional(),
});

export const SkillSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  prompt_addendum: z.string(),
  tools: z.array(ToolSchema).optional(),
});

// ── Content block ──
export const ContentBlockSchema = z.object({
  type: z.enum(['text', 'image', 'document']),
  text: z.string().optional(),
  source: z
    .object({
      type: z.literal('base64'),
      media_type: z.string(),
      data: z.string(),
    })
    .optional(),
});

// ── Conversation message ──
export const ConversationMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.union([z.string(), z.array(ContentBlockSchema)]),
});

// ── Agent request ──
export const AgentRequestSchema = z.object({
  model: z.string().optional(),
  input: z.union([z.string(), z.array(ConversationMessageSchema)]),
  instructions: z.string().optional(),
  tools: z.array(ToolSchema).optional(),
  allowed_skills: z.array(z.string()).optional(),
  max_output_tokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  stream: z.boolean().optional().default(false),
  reasoning: z
    .object({
      effort: z.enum(['low', 'medium', 'high']),
    })
    .optional(),
  text: z
    .object({
      format: z.object({
        type: z.enum(['text', 'json_schema']),
        json_schema: z.record(z.unknown()).optional(),
      }),
    })
    .optional(),
  previous_response_id: z.string().optional(),
  model_fallback: z.array(z.string()).optional(),
  preset: z.string().optional(),
  chat_id: z.string().optional(),
  working_directory: z.string().optional(),
});

// ── Sandbox config ──
export const SandboxConfigSchema = z.object({
  language: z.enum(['python', 'javascript', 'sql']),
  chat_id: z.string().min(1).optional(),
  task_id: z.string().min(1).optional(),
  working_directory: z.string().min(1).optional(),
  timeout_seconds: z.number().int().positive().max(3600).optional(),
  packages: z.array(z.string()).optional(),
  files: z
    .array(
      z.object({
        path: z.string(),
        content_base64: z.string(),
      })
    )
    .optional(),
});

// ── Execute code ──
export const ExecuteCodeSchema = z.object({
  code: z.string().min(1),
  timeout_seconds: z.number().int().positive().max(300).optional(),
});

// ── Workflow config ──
export const WorkflowConfigSchema = z
  .object({
    objective: z.string().trim().min(1, 'Objective cannot be empty').max(10000),
    orchestrator_model: z.string().optional(),
    chat_id: z.string().min(1).optional(),
    model_overrides: z.record(z.string()).optional(),
    model_fallback: z.array(z.string()).optional(),
    working_directory: z.string().min(1).optional(),
    tools: z.array(z.string()).optional(),
    max_credits: z.number().positive().max(10000).optional(),
    callback_url: z.string().url().optional(),
    webhook_secret: z.string().min(1).optional(),
    human_approval: z.boolean().optional().default(false),
    context_files: z
      .array(
        z.object({
          filename: z.string().max(500),
          content_base64: z.string().max(2 * 1024 * 1024), // ~1.5MB decoded
          media_type: z.string().max(100),
        })
      )
      .max(20)
      .optional(),
    background: z.boolean().optional().default(false),
  })
  .refine((data) => !data.webhook_secret || !!data.callback_url, {
    message: 'callback_url is required when webhook_secret is provided',
    path: ['callback_url'],
  });

// ── Agent type ──
export const AgentTypeSchema = z.enum(['research', 'analyze', 'write', 'code', 'file', 'deep_research']);

// ── Legacy DAG Task (kept for backward compat) ──
export const DAGTaskSchema = z.object({
  task_id: z.string(),
  parent_task_ids: z.array(z.string()),
  task_type: z.enum([
    'llm_completion',
    'web_search',
    'code_execution',
    'browser_action',
    'file_operation',
    'api_call',
    'human_approval',
    'research',
    'analyze',
    'write',
    'code',
    'file',
    'deep_research',
  ]),
  description: z.string(),
  model: z.string().optional().nullable(),
  tools: z.array(ToolSchema).optional().nullable(),
  input_template: z.string(),
});

export const DAGPlanSchema = z.object({
  tasks: z.array(DAGTaskSchema).min(1),
});

// ── Billing ──
export const TopUpSchema = z.object({
  amount: z.number().positive(),
});

export const UsageQuerySchema = z.object({
  start: z.string().optional(),
  end: z.string().optional(),
});

// ── Workflow approval ──
export const WorkflowApprovalSchema = z.object({
  task_id: z.string(),
  approved: z.boolean(),
  feedback: z.string().optional(),
});

// ── Bash tool approval ──
export const BashApprovalSchema = z.object({
  approval_id: z.string().min(1, 'approval_id is required'),
  decision: z.enum(['approve', 'deny', 'approve_all_session', 'approve_command_session']),
});

// ── Pagination ──
export const PaginationSchema = z.object({
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().positive().max(100).optional().default(20),
  status: z.string().optional(),
});
