#!/usr/bin/env node
/**
 * Runs `next dev` the way `smoke:dev` and the Playwright harness already do:
 * Next only reads `.env` from the directory it starts in, that directory is
 * `apps/web`, and the repository's `.env` lives at the root. Left alone, a
 * bare `pnpm dev` starts with an empty environment — no `DATABASE_URL`, no
 * `ENCRYPTION_MASTER_KEY` — even though the file is right there one level up.
 *
 * So this reads the root `.env` first and hands it to the dev server as its
 * environment, same as `scripts/smoke-boot.mjs` and `apps/web/playwright.config.ts`
 * do for their own runs. Real shell-exported variables still win over the file.
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

function repoEnv() {
  const values = {}
  let contents
  try {
    contents = readFileSync(join(repoRoot, '.env'), 'utf8')
  } catch {
    return values
  }
  for (const line of contents.split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match?.[1]) continue
    values[match[1]] = (match[2] ?? '').trim().replace(/^["'](.*)["']$/, '$1')
  }
  return values
}

const env = { ...repoEnv(), ...process.env }

const child = spawn(
  'pnpm',
  ['--filter', '@sortiva/web', 'run', 'dev', ...process.argv.slice(2)],
  { cwd: repoRoot, env, stdio: 'inherit' },
)

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal))
}

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
