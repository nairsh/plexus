import type { AgentType } from '@orchestrator/shared';

const AGENT_VERB: Record<AgentType, string> = {
  research: 'Researching',
  analyze: 'Analyzing',
  write: 'Writing',
  code: 'Coding',
  file: 'Updating',
};

const LEADING_VERB =
  /^(research|analyze|write|draft|code|implement|build|fix|update|create|review|inspect|gather|compile)\s+/i;

const compactWhitespace = (value: string): string => value.replace(/\s+/g, ' ').trim();

const sentenceCase = (value: string): string => {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
};

const truncate = (value: string, maxLength = 72): string => {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}…`;
};

export const buildDisplayDescription = (description: string, agentType: AgentType): string => {
  const clean = compactWhitespace(description.replace(/[.:;!?]+$/, ''));
  if (!clean) {
    return `${AGENT_VERB[agentType]} task`;
  }

  const lowered = clean.toLowerCase();
  if (
    lowered.startsWith('researching ') ||
    lowered.startsWith('analyzing ') ||
    lowered.startsWith('writing ') ||
    lowered.startsWith('coding ') ||
    lowered.startsWith('updating ')
  ) {
    return truncate(sentenceCase(clean));
  }

  const withoutLeadingVerb = clean.replace(LEADING_VERB, '');
  return truncate(`${AGENT_VERB[agentType]} ${withoutLeadingVerb}`);
};
