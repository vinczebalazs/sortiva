import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import sortiva from 'eslint-plugin-sortiva'

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      'tmp/**',
      'docs/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    plugins: { sortiva },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',

      // Invariant 25 — one instrumented wrapper per vendor SDK.
      'sortiva/no-direct-provider-sdk': 'error',

      // Invariant 9 — every threshold number lives in packages/rules.
      'sortiva/no-threshold-literals': 'error',
    },
  },

  // packages/rules is the one place threshold numbers are allowed to be compared.
  {
    files: ['packages/rules/**/*.{ts,tsx,js,mjs}'],
    rules: { 'sortiva/no-threshold-literals': 'off' },
  },

  // Tests and fixtures assert against concrete numbers by definition; the rule
  // exists to stop *production* code carrying thresholds, not to stop tests
  // proving that packages/rules serves the right ones.
  {
    files: ['**/*.test.{ts,tsx}', '**/*.spec.{ts,tsx}', '**/fixtures/**', '**/__fixtures__/**'],
    rules: { 'sortiva/no-threshold-literals': 'off' },
  },

  // CLAUDE.md: route handlers parse -> call core -> serialise.
  {
    files: ['apps/web/app/api/**/route.{ts,tsx}'],
    rules: { 'sortiva/route-handler-imports': 'error' },
  },

  {
    files: ['**/*.{jsx,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
  },

  {
    files: ['scripts/**/*.mjs', 'tools/**/*.js', '*.config.{js,mjs,ts}'],
    rules: { '@typescript-eslint/no-unused-vars': 'off' },
  },
)
