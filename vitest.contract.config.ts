import { defineConfig } from 'vitest/config'

// The contract suite talks to the real vendors with real credentials; run it on demand.
export default defineConfig({
  test: {
    include: ['**/*.contract.test.ts'],
    exclude: ['node_modules/**'],
    testTimeout: 120_000,
    fileParallelism: false,
  },
})
