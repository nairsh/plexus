import { describe, expect, test } from 'vitest';
import { validatePath } from '@orchestrator/sandbox';

describe('sandbox path safety', () => {
  const sessionDir = '/tmp/sandbox/session-123';

  test('allows simple relative paths', () => {
    expect(validatePath(sessionDir, 'file.txt')).toBe(`${sessionDir}/file.txt`);
    expect(validatePath(sessionDir, 'src/main.ts')).toBe(`${sessionDir}/src/main.ts`);
  });

  test('rejects path traversal with ..', () => {
    expect(() => validatePath(sessionDir, '../etc/passwd')).toThrow('Path traversal');
    expect(() => validatePath(sessionDir, 'src/../../etc/passwd')).toThrow('Path traversal');
    expect(() => validatePath(sessionDir, '../../root')).toThrow('Path traversal');
  });

  test('rejects absolute paths', () => {
    expect(() => validatePath(sessionDir, '/etc/passwd')).toThrow('Path traversal');
    expect(() => validatePath(sessionDir, '/tmp/other/file')).toThrow('Path traversal');
  });

  test('allows nested directory paths', () => {
    expect(validatePath(sessionDir, 'a/b/c/d.txt')).toBe(`${sessionDir}/a/b/c/d.txt`);
  });

  test('normalizes redundant slashes', () => {
    const result = validatePath(sessionDir, 'src//main.ts');
    expect(result).toBe(`${sessionDir}/src/main.ts`);
  });
});
