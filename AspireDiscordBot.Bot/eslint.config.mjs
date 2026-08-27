import eslint from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: ['coverage/**', 'dist/**', 'node_modules/**'],
  },
  eslint.configs.recommended,
  ...[...tseslint.configs.strictTypeChecked, ...tseslint.configs.stylisticTypeChecked].map(
    (config) => ({
      ...config,
      files: ['**/*.ts'],
    }),
  ),
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-floating-promises': ['error', { checkThenables: true }],
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/only-throw-error': 'error',
      '@typescript-eslint/prefer-readonly': 'error',
      '@typescript-eslint/prefer-nullish-coalescing': 'off',
      '@typescript-eslint/promise-function-async': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-confusing-void-expression': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
