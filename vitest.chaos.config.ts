import { defineConfig } from 'vitest/config'

/**
 * `pnpm chaos` — main §14.3.9's kill-and-converge test, on its own gate. tech §5
 * runs it nightly: each scenario restarts a full synthetic run several times.
 */
export default defineConfig({
  test: {
    include: ['packages/**/*.chaos.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**'],
    environment: 'node',
    globals: false,
    testTimeout: 120_000,
    // Scenarios share one database and kill workers; running them in parallel
    // would produce interference that looks exactly like a convergence failure.
    fileParallelism: false,
  },
})
