import { readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'

/**
 * `pnpm eval` — the frozen evaluation sets, on their own gate. They run when a
 * prompt or a model id changes rather than on every merge, because they call the
 * model and cost real money.
 */

/**
 * The model key, read out of the repository's own `.env`.
 *
 * Vitest reads `.env` files but only hands `VITE_`-prefixed values to the code
 * under test, so `ANTHROPIC_API_KEY` never arrived and every set refused to run
 * — correctly, but for a reason that reads as a missing key rather than as a
 * suite that could not see the one sitting beside it. Parsed the same way
 * `scripts/smoke-boot.mjs` and the Playwright harness parse it. An exported
 * value wins, which is how CI supplies its own.
 */
function repoEnv(): Record<string, string> {
  let contents: string
  try {
    contents = readFileSync(new URL('.env', import.meta.url), 'utf8')
  } catch {
    return {}
  }
  const values: Record<string, string> = {}
  for (const line of contents.split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match?.[1] || process.env[match[1]] !== undefined) continue
    values[match[1]] = (match[2] ?? '').trim().replace(/^["'](.*)["']$/, '$1')
  }
  return values
}

export default defineConfig({
  test: {
    include: ['packages/**/*.eval.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**'],
    environment: 'node',
    globals: false,
    env: repoEnv(),
    // One model call per case, run one at a time: a set of fifty is minutes of
    // wall clock. The suite sets its own per-test timeout; this is the ceiling
    // for anything that does not.
    testTimeout: 30 * 60 * 1000,
    hookTimeout: 30 * 60 * 1000,
    // The scores are the output of a run that costs about eighty model calls.
    // Without this vitest buffers them behind its own reporter.
    disableConsoleIntercept: true,
  },
})
