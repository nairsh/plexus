import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAllSkills, refreshSkillsCache } from '@orchestrator/model-router';

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
});
