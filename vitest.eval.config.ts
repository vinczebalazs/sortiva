import { defineConfig } from 'vitest/config'

/**
 * `pnpm eval` — the frozen evaluation sets, on their own gate. They run when a
 * prompt or a model id changes rather than on every merge, because they call the
 * model and cost real money.
 */
export default defineConfig({
  test: {
    include: ['packages/**/*.eval.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**'],
    environment: 'node',
    globals: false,
    // One model call per case; the per-test timeout in the suite governs.
    testTimeout: 300_000,
  },
})
