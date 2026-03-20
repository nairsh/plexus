export type PillStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface StepPill {
  id: string;
  taskId?: string;
  title: string;
  subtitle: string;
  status: PillStatus;
  updatedAt: number;
  source: 'task' | 'tool' | 'system';
}

interface ToolInput {
  query?: string;
  url?: string;
  path?: string;
  command?: string;
  filePath?: string;
  pattern?: string;
  description?: string;
}

const AGENT_PREFIX: Record<string, string> = {
  research: 'Researching',
  analyze: 'Analyzing',
  write: 'Writing',
  code: 'Coding',
  file: 'Updating',
  deep_research: 'Deep researching',
};

const RUNNING_SUBTITLE: Record<string, string> = {
  research: 'Compiling sources...',
  analyze: 'Reviewing findings...',
  write: 'Drafting response...',
  code: 'Implementing changes...',
  file: 'Updating files...',
  deep_research: 'Compiling sources...',
};

function toSentenceCase(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return 'Working';
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function compactWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function removeLeadingVerb(text: string): string {
  return text.replace(
    /^(deep research|research|analyze|write|draft|code|implement|build|fix|update|create|review|inspect|gather|compile)\s+/i,
    ''
  );
}

export function truncateText(text: string, maxLength: number): string {
  const cleaned = compactWhitespace(text);
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength - 1)}…`;
}

export function taskTitle(description: string, agentType?: string): string {
  const cleaned = compactWhitespace(description.replace(/[.:;!?]+$/, ''));
  if (!cleaned) return 'Working on task';

  const lower = cleaned.toLowerCase();
  if (
    lower.startsWith('researching ') ||
    lower.startsWith('deep researching ') ||
    lower.startsWith('analyzing ') ||
    lower.startsWith('writing ') ||
    lower.startsWith('coding ') ||
    lower.startsWith('updating ')
  ) {
    return truncateText(toSentenceCase(cleaned), 52);
  }

  const prefix = AGENT_PREFIX[agentType ?? ''] ?? 'Working on';
  return truncateText(`${prefix} ${removeLeadingVerb(cleaned)}`, 52);
}

export function taskSubtitle(status: PillStatus, agentType?: string): string {
  if (status === 'pending') return 'Queued...';
  if (status === 'completed') return 'Step complete';
  if (status === 'failed') return 'Needs attention';
  return RUNNING_SUBTITLE[agentType ?? ''] ?? 'Working...';
}

function normalizePath(path?: string): string | null {
  if (!path) return null;
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0) return null;
  return parts[parts.length - 1] ?? null;
}

export function toolStepText(toolName: string, rawInput: unknown): { title: string; subtitle: string } {
  const input = (rawInput && typeof rawInput === 'object' ? rawInput : {}) as ToolInput;

  if (toolName === 'web_search') {
    const query = truncateText(input.query ?? 'the topic', 38);
    return { title: `Researching ${query}`, subtitle: 'Compiling sources...' };
  }

  if (toolName === 'fetch_url') {
    const url = truncateText(input.url ?? 'reference page', 38);
    return { title: `Reading ${url}`, subtitle: 'Reviewing source...' };
  }

  if (toolName === 'file_read') {
    const name = normalizePath(input.path) ?? normalizePath(input.filePath) ?? 'file';
    return { title: `Reading ${name}`, subtitle: 'Inspecting details...' };
  }

  if (toolName === 'file_write') {
    const name = normalizePath(input.path) ?? normalizePath(input.filePath) ?? 'file';
    return { title: `Writing ${name}`, subtitle: 'Saving updates...' };
  }

  if (toolName === 'file_edit') {
    const name = normalizePath(input.path) ?? normalizePath(input.filePath) ?? 'file';
    return { title: `Editing ${name}`, subtitle: 'Applying changes...' };
  }

  if (toolName === 'grep') {
    const pattern = truncateText(input.pattern ?? 'pattern', 32);
    return { title: `Scanning for ${pattern}`, subtitle: 'Searching files...' };
  }

  if (toolName === 'glob') {
    return { title: 'Finding relevant files', subtitle: 'Scanning workspace...' };
  }

  if (toolName === 'bash') {
    const command = truncateText(input.command ?? 'command', 30);
    return { title: `Running ${command}`, subtitle: 'Executing command...' };
  }

  if (toolName === 'run_skill') {
    const skill = truncateText((input.description ?? 'skill') as string, 28);
    return { title: `Applying ${skill}`, subtitle: 'Following workflow...' };
  }

  return {
    title: `Running ${toolName.replace(/_/g, ' ')}`,
    subtitle: 'Executing step...',
  };
}

export function upsertStepPill(pills: StepPill[], next: StepPill, maxRetained = 18): StepPill[] {
  const existingIndex = pills.findIndex((pill) => pill.id === next.id);
  const merged =
    existingIndex >= 0 ? pills.map((pill, index) => (index === existingIndex ? next : pill)) : [next, ...pills];

  return merged.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, maxRetained);
}

export function latestStepPills(pills: StepPill[], maxVisible = 3): StepPill[] {
  return [...pills].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, maxVisible);
}
