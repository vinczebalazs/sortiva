import { defineConfig } from 'vitest/config'

/**
 * `pnpm chaos` — the kill-and-converge test, on its own gate. Nightly rather
 * than per-merge: each scenario restarts a full synthetic run several times.
 */
export default defineConfig({
  test: {
    include: ['packages/**/*.chaos.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**'],
    environment: 'node',
    globals: false,
    testTimeout: 120_000,
    // Same reason as the unit run: build the migrated database the suites are
    // copied from before any of them starts, so no setup hook is charged for it.
    globalSetup: ['packages/db/src/testing.global-setup.ts'],
    // Scenarios share one database and kill workers; running them in parallel
    // would produce interference that looks exactly like a convergence failure.
    fileParallelism: false,
  },
})
