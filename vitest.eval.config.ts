import { defineConfig } from 'vitest/config'

/**
 * `pnpm eval` — main §14.2's frozen eval sets, on their own gate. tech §5 runs
 * them "when prompts/models changed", not on every merge, because they call the
 * model and cost money.
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
