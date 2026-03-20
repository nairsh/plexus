import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettierConfig,
  {
    rules: {
      // Catch empty catch blocks (enforce logging)
      'no-empty': ['warn', { allowEmptyCatch: false }],
      // Disallow unused vars except those prefixed with _
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Disallow floating promises
      '@typescript-eslint/no-floating-promises': 'error',
      // Allow explicit any in limited cases
      '@typescript-eslint/no-explicit-any': 'warn',
    },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    ignores: [
      'node_modules/**',
      'packages/*/node_modules/**',
      'dist/**',
      '*.js',
      '*.mjs',
      'eslint.config.mjs',
    ],
  }
);
