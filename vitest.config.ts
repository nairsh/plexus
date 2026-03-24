import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@orchestrator/shared': path.resolve(__dirname, 'packages/shared/src/index.ts'),
      '@orchestrator/model-router': path.resolve(__dirname, 'packages/model-router/src/index.ts'),
      '@orchestrator/billing': path.resolve(__dirname, 'packages/billing/src/index.ts'),
      '@orchestrator/sandbox': path.resolve(__dirname, 'packages/sandbox/src/index.ts'),
      '@orchestrator/orchestrator': path.resolve(__dirname, 'packages/orchestrator/src/index.ts'),
      '@orchestrator/memory': path.resolve(__dirname, 'packages/memory/src/index.ts'),
    },
  },
  test: {
    globals: false,
    environment: 'node',
    testTimeout: 30000,
  },
});
