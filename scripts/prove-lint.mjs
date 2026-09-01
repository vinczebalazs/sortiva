#!/usr/bin/env node
/**
 * T0.1 done-when: "`pnpm lint` fails on a deliberately planted raw SDK import
 * and on a planted `if (position < 15)` outside rules." R1 adds the same proof
 * for the account-scoping rule (remediation D5).
 *
 * Rather than proving that by hand once, this plants each violation in a
 * throwaway file, runs the real lint command, asserts it failed with the
 * expected rule, and removes the file. CI runs it on every merge, so the
 * enforcement rules can never silently stop working.
 *
 * Cases live one-per-file in `scripts/lint-proofs/` and are discovered, so a lane
 * adding a rule adds a file rather than editing a list every other lane edits.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

const CASES = await loadCases()

/**
 * One case per file in `scripts/lint-proofs/`, discovered rather than listed.
 *
 * This used to be a single array, and five cards edited it in wave 1 — a merge
 * conflict in the check that proves every other check still works is the worst
 * place to resolve one by hand. A lane now adds a file; nobody edits a shared
 * list. The count is asserted below so a file that fails to load cannot quietly
 * reduce the number of things being proved.
 */
async function loadCases() {
  const dir = join(repoRoot, 'scripts', 'lint-proofs')
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.mjs'))
    .sort()
  const loaded = []
  for (const file of files) {
    const mod = await import(pathToFileURL(join(dir, file)).href)
    if (!mod.default?.name || !mod.default?.file || !mod.default?.expectRule) {
      throw new Error(`${file} does not export a case with name, file and expectRule`)
    }
    loaded.push(mod.default)
  }
  if (loaded.length === 0) {
    throw new Error('No planted violations found. An empty proof proves nothing.')
  }
  return loaded
}

/** Runs `eslint` on one file and returns its JSON report (exit code 1 is the expected path). */
function lintFile(relPath) {
  try {
    const stdout = execFileSync(
      'pnpm',
      ['exec', 'eslint', '--format', 'json', '--no-warn-ignored', relPath],
      { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
    return { failed: false, report: JSON.parse(stdout) }
  } catch (error) {
    const stdout = error.stdout?.toString() ?? ''
    if (!stdout.trim().startsWith('[')) {
      throw new Error(`eslint did not produce a JSON report:\n${stdout}\n${error.stderr ?? ''}`)
    }
    return { failed: true, report: JSON.parse(stdout) }
  }
}

let failures = 0

for (const testCase of CASES) {
  const abs = join(repoRoot, testCase.file)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, testCase.source)
  try {
    const { failed, report } = lintFile(testCase.file)
    const ruleIds = report.flatMap((r) => r.messages.map((m) => m.ruleId))
    const ok = failed && ruleIds.includes(testCase.expectRule)
    if (ok) {
      console.log(`PASS  lint rejects ${testCase.name}`)
    } else {
      failures += 1
      console.error(`FAIL  lint accepted ${testCase.name}`)
      console.error(`      exit-nonzero=${failed} rules=${JSON.stringify(ruleIds)}`)
    }
  } finally {
    rmSync(dirname(abs), { recursive: true, force: true })
  }
}

if (failures > 0) {
  console.error(`\n${failures} enforcement rule(s) are not firing.`)
  process.exit(1)
}
console.log(`\nAll ${CASES.length} planted violations were rejected by \`pnpm lint\`.`)
