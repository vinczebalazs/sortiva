import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/**/*.{test,spec}.ts', 'apps/**/*.{test,spec}.ts', 'tools/**/*.{test,spec}.ts'],
    // The eval sets (`pnpm eval`), the chaos test (`pnpm chaos`) and the
    // Playwright flows (`pnpm e2e`) each run on
    // their own CI gate at their own cadence, so they are not part of the
    // per-merge unit run.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/*.e2e.spec.ts',
      '**/*.eval.spec.ts',
      '**/*.chaos.spec.ts',
    ],
    environment: 'node',
    globals: false,
    reporters: ['default'],
  },
})
