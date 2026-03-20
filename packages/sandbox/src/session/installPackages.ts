import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getErrorMessage, SandboxError } from '@orchestrator/shared';

export async function installPackages(workspaceDir: string, language: string, packages: string[]): Promise<void> {
  const sanitized = packages.map((p) => p.replace(/[;&|`$(){}]/g, ''));
  const timeout = 60_000; // 60s for package installation

  if (language === 'python') {
    const packagesDir = join(workspaceDir, '.packages');
    mkdirSync(packagesDir, { recursive: true });
    try {
      execSync(`python3 -m pip install --target "${packagesDir}" ${sanitized.join(' ')}`, {
        cwd: workspaceDir,
        timeout,
        stdio: 'pipe',
      });
    } catch (err) {
      throw new SandboxError(`Failed to install Python packages: ${getErrorMessage(err)}`);
    }
    return;
  }

  if (language === 'javascript') {
    if (!existsSync(join(workspaceDir, 'package.json'))) {
      writeFileSync(
        join(workspaceDir, 'package.json'),
        JSON.stringify({ name: 'sandbox', version: '1.0.0', type: 'module' })
      );
    }
    try {
      execSync(`npm install --prefix "${workspaceDir}" ${sanitized.join(' ')}`, {
        cwd: workspaceDir,
        timeout,
        stdio: 'pipe',
      });
    } catch (err) {
      throw new SandboxError(`Failed to install Node packages: ${getErrorMessage(err)}`);
    }
    return;
  }
}
