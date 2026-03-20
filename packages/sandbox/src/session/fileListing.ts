import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const IGNORED_DIRS = new Set(['node_modules', '.packages', '.git', 'dist']);

export function listFilesRecursive(dir: string, prefix = ''): string[] {
  const results: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        results.push(...listFilesRecursive(join(dir, entry.name), rel));
      } else {
        results.push(rel);
      }
    }
  } catch {
    // Directory may not exist
  }
  return results;
}
