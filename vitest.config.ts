import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/**/*.{test,spec}.ts', 'apps/**/*.{test,spec}.ts', 'tools/**/*.{test,spec}.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/*.e2e.spec.ts'],
    environment: 'node',
    globals: false,
    reporters: ['default'],
  },
})
