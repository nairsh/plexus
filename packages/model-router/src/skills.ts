import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getErrorMessage, logger } from '@orchestrator/shared';
import type { AgentRequest, Skill, Tool } from '@orchestrator/shared';

const RESERVED_NAMES = new Set(['anthropic', 'claude']);
const NAME_REGEX = /^[a-z0-9-]{1,64}$/;
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = resolve(MODULE_DIR, '../../..');
const DEFAULT_SKILLS_DIR = join(BACKEND_ROOT, 'skills');

let cachedSkills: Skill[] | null = null;

interface FrontmatterResult {
  meta: Record<string, string | string[]>;
  body: string;
}

export interface UpsertSkillInput {
  name?: string;
  description: string;
  prompt_addendum: string;
  tools?: Tool[];
}

export function getSkillsRoot(): string {
  // Skills are backend-local by default (repoRoot/skills).
  // Keep a test-only override so unit tests can isolate filesystem state.
  if ((process.env['NODE_ENV'] === 'test' || process.env['VITEST']) && process.env['CLAUDE_SKILLS_PATH']) {
    return process.env['CLAUDE_SKILLS_PATH'];
  }
  return DEFAULT_SKILLS_DIR;
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

export function upsertSkill(skillId: string, input: UpsertSkillInput): Skill {
  assertValidSkillId(skillId);

  const name = (input.name ?? skillId).trim();
  const description = input.description.trim();
  const promptAddendum = input.prompt_addendum.trim();
  const tools = normalizeSkillTools(input.tools ?? []);

  validateSkillMetadata(skillId, name, description);

  const root = getSkillsRoot();
  mkdirSync(root, { recursive: true });

  const skillDir = join(root, skillId);
  mkdirSync(skillDir, { recursive: true });

  const content = serializeSkillFile({
    id: skillId,
    name,
    description,
    prompt_addendum: promptAddendum,
    tools,
  });

  writeFileSync(join(skillDir, 'SKILL.md'), content, 'utf-8');
  refreshSkillsCache();

  return {
    id: skillId,
    name,
    description,
    prompt_addendum: promptAddendum,
    tools: tools.length > 0 ? tools : undefined,
  };
}

export function deleteSkill(skillId: string): boolean {
  assertValidSkillId(skillId);

  const skillDir = join(getSkillsRoot(), skillId);
  try {
    if (!statSync(skillDir).isDirectory()) {
      return false;
    }
  } catch {
    return false;
  }

  rmSync(skillDir, { recursive: true, force: true });
  refreshSkillsCache();
  return true;
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

    const tools = parseToolsFromMeta(meta);

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
  let blockKey: string | null = null;
  let blockMode: 'literal' | 'folded' = 'literal';
  let blockIndent: number | null = null;
  let blockLines: string[] = [];

  const flushBlock = () => {
    if (!blockKey) return;
    const value = blockMode === 'folded'
      ? blockLines.join('\n').replace(/\n{2,}/g, '\n\n').replace(/\n/g, ' ')
      : blockLines.join('\n');
    meta[blockKey] = value.trim();
    blockKey = null;
    blockIndent = null;
    blockLines = [];
  };

  let idx = 0;
  while (idx < lines.length) {
    const line = lines[idx] ?? '';
    const trimmed = line.trim();

    if (blockKey) {
      if (!trimmed) {
        blockLines.push('');
        idx += 1;
        continue;
      }

      const indent = line.match(/^\s*/)![0].length;
      if (blockIndent === null) {
        blockIndent = indent;
      }

      if (indent < blockIndent) {
        flushBlock();
        continue;
      }

      blockLines.push(line.slice(blockIndent));
      idx += 1;
      continue;
    }

    if (!trimmed || trimmed.startsWith('#')) {
      idx += 1;
      continue;
    }

    const listMatch = trimmed.match(/^-\s+(.*)$/);
    if (listMatch && currentListKey) {
      const value = stripQuotes(listMatch[1].trim());
      const existing = meta[currentListKey];
      if (Array.isArray(existing)) {
        existing.push(value);
      } else {
        meta[currentListKey] = [value];
      }
      idx += 1;
      continue;
    }

    const kvMatch = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kvMatch) {
      currentListKey = null;
      idx += 1;
      continue;
    }

    const key = kvMatch[1];
    const rawValue = kvMatch[2].trim();

    if (rawValue === '|' || rawValue === '>') {
      currentListKey = null;
      blockKey = key;
      blockMode = rawValue === '>' ? 'folded' : 'literal';
      blockIndent = null;
      blockLines = [];
      idx += 1;
      continue;
    }

    if (!rawValue) {
      currentListKey = key;
      meta[key] = [];
      idx += 1;
      continue;
    }

    currentListKey = null;
    meta[key] = stripQuotes(rawValue);
    idx += 1;
  }

  flushBlock();

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
    const normalizedType = normalizeToolType(entry);
    if (!normalizedType) {
      throw new Error(`Unsupported tool type '${entry}' in SKILL.md tools`);
    }
    tools.push({ type: normalizedType });
  }

  return tools;
}

function parseToolsFromMeta(meta: Record<string, string | string[]>): Tool[] {
  const directTools = parseTools(meta['tools']);
  if (directTools.length > 0) return directTools;
  return parseTools(meta['allowed-tools'] ?? meta['allowed_tools']);
}

function normalizeToolType(value: string): Tool['type'] | null {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, '_');

  const aliasMap: Record<string, Tool['type']> = {
    web_search: 'web_search',
    'web-search': 'web_search',
    websearch: 'web_search',
    fetch_url: 'fetch_url',
    'fetch-url': 'fetch_url',
    fetchurl: 'fetch_url',
    function: 'function',
    code_execution: 'code_execution',
    'code-execution': 'code_execution',
    file_read: 'file_read',
    'file-read': 'file_read',
    read: 'file_read',
    file_write: 'file_write',
    'file-write': 'file_write',
    write: 'file_write',
    file_edit: 'file_edit',
    'file-edit': 'file_edit',
    edit: 'file_edit',
    bash: 'bash',
    grep: 'grep',
    glob: 'glob',
    run_skill: 'run_skill',
    'run-skill': 'run_skill',
    remember: 'remember',
    recall: 'recall',
  };

  return aliasMap[normalized] ?? null;
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
    'remember',
    'recall',
  ].includes(value);
}

function normalizeSkillTools(tools: Tool[]): Tool[] {
  const normalized: Tool[] = [];
  const seen = new Set<string>();

  for (const tool of tools) {
    const type = tool.type;
    if (!isToolType(type)) {
      throw new Error(`Unsupported tool type '${String(type)}' in skill tools`);
    }
    if (seen.has(type)) continue;
    seen.add(type);
    normalized.push({ type });
  }

  return normalized;
}

function assertValidSkillId(skillId: string): void {
  if (!NAME_REGEX.test(skillId)) {
    throw new Error(`Invalid skill id '${skillId}'`);
  }
  if (RESERVED_NAMES.has(skillId)) {
    throw new Error(`Skill name '${skillId}' is reserved`);
  }
}

function serializeSkillFile(skill: Skill): string {
  const lines: string[] = ['---', `name: ${skill.name}`];

  if (skill.description.includes('\n')) {
    lines.push('description: |');
    for (const line of skill.description.split('\n')) {
      lines.push(`  ${line}`);
    }
  } else {
    lines.push(`description: ${skill.description}`);
  }

  if (skill.tools && skill.tools.length > 0) {
    lines.push('tools:');
    for (const tool of skill.tools) {
      lines.push(`  - ${tool.type}`);
    }
  }

  lines.push('---', '', skill.prompt_addendum.trim(), '');
  return lines.join('\n');
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
