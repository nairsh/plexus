import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getErrorMessage, logger } from '@orchestrator/shared';
import type { AgentRequest, Skill, Tool } from '@orchestrator/shared';

const RESERVED_NAMES = new Set(['anthropic', 'claude']);
const NAME_REGEX = /^[a-z0-9-]{1,64}$/;
const DEFAULT_SKILLS_DIR = join(homedir(), '.claude', 'skills');

let cachedSkills: Skill[] | null = null;

interface FrontmatterResult {
  meta: Record<string, string | string[]>;
  body: string;
}

export function getSkillsRoot(): string {
  // Read directly (not via cached getEnv()) so tests can override CLAUDE_SKILLS_PATH at runtime.
  return process.env['CLAUDE_SKILLS_PATH'] ?? DEFAULT_SKILLS_DIR;
}

export function refreshSkillsCache(): void {
  cachedSkills = null;
}

export function getAllSkills(): Skill[] {
  if (cachedSkills) return cachedSkills;
  cachedSkills = loadSkillsFromDisk();
  return cachedSkills;
}

export function getSkillById(skillId: string): Skill | null {
  const skills = getAllSkills();
  return skills.find((skill) => skill.id === skillId) ?? null;
}

export function ensureRunSkillTool(tools?: Tool[]): Tool[] | undefined {
  if (!tools || tools.length === 0) return tools;
  const hasRunSkill = tools.some((tool) => tool.type === 'run_skill');
  return hasRunSkill ? tools : [...tools, { type: 'run_skill' }];
}

export function applySkillToRequest(
  request: AgentRequest,
  skill: Skill,
  input?: string
): { systemMessage: string } {
  const skillSection = formatSkillSection(skill, input);
  const updatedInstructions = request.instructions
    ? `${request.instructions}\n\n${skillSection}`
    : skillSection;

  request.instructions = updatedInstructions;
  request.tools = mergeTools(request.tools ?? [], skill.tools ?? []);

  return { systemMessage: skillSection };
}

function loadSkillsFromDisk(): Skill[] {
  const root = getSkillsRoot();
  let entries: Array<{ name: string; path: string }> = [];

  try {
    const dirents = readdirSync(root, { withFileTypes: true });
    entries = dirents
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => ({ name: dirent.name, path: join(root, dirent.name) }));
  } catch (err) {
    logger.debug({ root, error: getErrorMessage(err) }, 'Skills directory not found or unreadable');
    return [];
  }

  const skills: Skill[] = [];

  for (const entry of entries) {
    const skillPath = join(entry.path, 'SKILL.md');
    try {
      if (!statSync(skillPath).isFile()) continue;
    } catch (err) {
      logger.debug({ skillPath, error: getErrorMessage(err) }, 'SKILL.md not found or inaccessible');
      continue;
    }

    const raw = readFileSync(skillPath, 'utf-8');
    const { meta, body } = parseFrontmatter(raw);

    const name = normalizeString(meta['name']);
    const description = normalizeString(meta['description']);

    validateSkillMetadata(entry.name, name, description);

    const tools = parseTools(meta['tools']);

    skills.push({
      id: entry.name,
      name,
      description,
      prompt_addendum: body.trim(),
      tools: tools.length > 0 ? tools : undefined,
    });
  }

  return skills;
}

function parseFrontmatter(raw: string): FrontmatterResult {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') {
    return { meta: {}, body: raw };
  }

  const metaLines: string[] = [];
  let idx = 1;
  while (idx < lines.length) {
    const line = lines[idx];
    if (line.trim() === '---') {
      idx += 1;
      break;
    }
    metaLines.push(line);
    idx += 1;
  }

  const body = lines.slice(idx).join('\n');
  const meta = parseYamlLike(metaLines);
  return { meta, body };
}

function parseYamlLike(lines: string[]): Record<string, string | string[]> {
  const meta: Record<string, string | string[]> = {};
  let currentListKey: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const listMatch = trimmed.match(/^-\s+(.*)$/);
    if (listMatch && currentListKey) {
      const value = stripQuotes(listMatch[1].trim());
      const existing = meta[currentListKey];
      if (Array.isArray(existing)) {
        existing.push(value);
      } else {
        meta[currentListKey] = [value];
      }
      continue;
    }

    const kvMatch = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kvMatch) {
      currentListKey = null;
      continue;
    }

    const key = kvMatch[1];
    const rawValue = kvMatch[2].trim();

    if (!rawValue) {
      currentListKey = key;
      meta[key] = [];
      continue;
    }

    currentListKey = null;
    meta[key] = stripQuotes(rawValue);
  }

  return meta;
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function normalizeString(value: string | string[] | undefined): string {
  if (!value) return '';
  if (Array.isArray(value)) return value.join(',').trim();
  return value.trim();
}

function validateSkillMetadata(
  folderName: string,
  name: string,
  description: string
): void {
  if (!name) {
    throw new Error(`SKILL.md missing required 'name' in ${folderName}`);
  }
  if (!description) {
    throw new Error(`SKILL.md missing required 'description' in ${folderName}`);
  }
  if (!NAME_REGEX.test(name)) {
    throw new Error(`Invalid skill name '${name}' in ${folderName}`);
  }
  if (RESERVED_NAMES.has(name)) {
    throw new Error(`Skill name '${name}' is reserved`);
  }
  if (name !== folderName) {
    throw new Error(`Skill folder '${folderName}' must match name '${name}'`);
  }
  if (description.length > 1024) {
    throw new Error(`Description too long for skill '${name}'`);
  }
  if (description.includes('<') || description.includes('>')) {
    throw new Error(`Description for skill '${name}' must not include XML tags`);
  }
}

function parseTools(value: string | string[] | undefined): Tool[] {
  if (!value) return [];
  const raw = Array.isArray(value)
    ? value
    : value.split(',').map((entry) => entry.trim()).filter(Boolean);

  const tools: Tool[] = [];
  for (const entry of raw) {
    if (!entry) continue;
    if (!isToolType(entry)) {
      throw new Error(`Unsupported tool type '${entry}' in SKILL.md tools`);
    }
    tools.push({ type: entry });
  }

  return tools;
}

function isToolType(value: string): value is Tool['type'] {
  return [
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
  ].includes(value);
}

function mergeTools(base: Tool[], extra: Tool[]): Tool[] {
  const merged: Tool[] = [];
  const seen = new Set<string>();

  for (const tool of [...base, ...extra]) {
    const key =
      tool.type === 'function' && tool.function?.name
        ? `function:${tool.function.name}`
        : tool.type;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(tool);
  }

  return merged;
}

function formatSkillSection(skill: Skill, input?: string): string {
  const lines = [
    'Skills',
    `- Name: ${skill.name}`,
    `- Description: ${skill.description}`,
  ];

  const body = skill.prompt_addendum?.trim();
  if (body) {
    lines.push('Instructions:', body);
  }

  if (input && input.trim()) {
    lines.push('Input:', input.trim());
  }

  return lines.join('\n');
}
