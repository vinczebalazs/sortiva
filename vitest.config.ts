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
    server: {
      deps: {
        // Auth.js's Next.js wrapper imports `next/server`, which only resolves
        // through the package's `exports` map. Node's own loader does not read
        // it, so the import fails unless Vite processes this package instead of
        // handing it to Node — which is what listing it here does. Needed to
        // drive the real sign-in handlers in a test.
        inline: ['next-auth'],
      },
    },
  },
})
