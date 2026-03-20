import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deleteSkill,
  getAllSkills,
  getSkillById,
  refreshSkillsCache,
  upsertSkill,
} from '@orchestrator/model-router';

const ORIGINAL_SKILLS_PATH = process.env['CLAUDE_SKILLS_PATH'];

function writeSkill(dir: string, name: string, content: string): void {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), content, 'utf-8');
}

describe('skills loader', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'skills-test-'));
    process.env['CLAUDE_SKILLS_PATH'] = tempRoot;
    refreshSkillsCache();
  });

  afterEach(() => {
    refreshSkillsCache();
    if (ORIGINAL_SKILLS_PATH) {
      process.env['CLAUDE_SKILLS_PATH'] = ORIGINAL_SKILLS_PATH;
    } else {
      delete process.env['CLAUDE_SKILLS_PATH'];
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test('loads a valid skill with tools and prompt', () => {
    writeSkill(
      tempRoot,
      'test-skill',
      [
        '---',
        'name: test-skill',
        'description: Example skill',
        'tools:',
        '  - web_search',
        '  - fetch_url',
        '---',
        'Use this skill to gather data.',
      ].join('\n')
    );

    const skills = getAllSkills();
    expect(skills.length).toBe(1);
    expect(skills[0]?.id).toBe('test-skill');
    expect(skills[0]?.name).toBe('test-skill');
    expect(skills[0]?.description).toBe('Example skill');
    expect(skills[0]?.prompt_addendum).toContain('Use this skill to gather data.');
    expect(skills[0]?.tools?.map((tool) => tool.type)).toEqual([
      'web_search',
      'fetch_url',
    ]);
  });

  test('rejects a folder/name mismatch', () => {
    writeSkill(
      tempRoot,
      'mismatch-skill',
      [
        '---',
        'name: other-skill',
        'description: Example skill',
        '---',
        'Body.',
      ].join('\n')
    );

    expect(() => getAllSkills()).toThrow(/folder.*match/i);
  });

  test('loads multiline description and allowed-tools aliases', () => {
    writeSkill(
      tempRoot,
      'qa',
      [
        '---',
        'name: qa',
        'description: |',
        '  Systematically QA test a web application.',
        '  Produces structured reports with evidence.',
        'allowed-tools:',
        '  - Bash',
        '  - Read',
        '  - Write',
        '---',
        'Use this for smoke tests and full regression checks.',
      ].join('\n')
    );

    const skill = getSkillById('qa');
    expect(skill).not.toBeNull();
    expect(skill?.description).toContain('Systematically QA test a web application.');
    expect(skill?.description).toContain('Produces structured reports with evidence.');
    expect(skill?.tools?.map((tool) => tool.type)).toEqual(['bash', 'file_read', 'file_write']);
  });

  test('upsertSkill creates and updates a skill on disk', () => {
    const created = upsertSkill('security-review', {
      description: 'Review code changes for security issues',
      prompt_addendum: 'Focus on auth, input validation, and data exposure.',
      tools: [{ type: 'grep' }, { type: 'file_read' }, { type: 'bash' }],
    });

    expect(created.id).toBe('security-review');
    expect(created.tools?.map((tool) => tool.type)).toEqual(['grep', 'file_read', 'bash']);

    const updated = upsertSkill('security-review', {
      description: 'Review code changes for high-impact vulnerabilities',
      prompt_addendum: 'Prioritize exploitability and trust boundaries.',
      tools: [{ type: 'grep' }, { type: 'bash' }, { type: 'grep' }],
    });

    expect(updated.description).toContain('high-impact vulnerabilities');
    expect(updated.tools?.map((tool) => tool.type)).toEqual(['grep', 'bash']);

    const loaded = getSkillById('security-review');
    expect(loaded?.description).toContain('high-impact vulnerabilities');
    expect(loaded?.tools?.map((tool) => tool.type)).toEqual(['grep', 'bash']);
  });

  test('deleteSkill removes an existing skill', () => {
    upsertSkill('cleanup-test', {
      description: 'Temporary skill for deletion tests',
      prompt_addendum: 'Delete me',
      tools: [{ type: 'bash' }],
    });

    expect(getSkillById('cleanup-test')).not.toBeNull();
    expect(deleteSkill('cleanup-test')).toBe(true);
    expect(getSkillById('cleanup-test')).toBeNull();
    expect(deleteSkill('cleanup-test')).toBe(false);
  });
});
