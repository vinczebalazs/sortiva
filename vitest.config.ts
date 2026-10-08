import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globalSetup: ['db/global-setup.ts'],
    include: ['**/*.test.ts'],
    exclude: ['node_modules/**', 'evals/**', '**/*.contract.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
