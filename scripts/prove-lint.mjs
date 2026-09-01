#!/usr/bin/env node
/**
 * T0.1 done-when: "`pnpm lint` fails on a deliberately planted raw SDK import
 * and on a planted `if (position < 15)` outside rules." R1 adds the same proof
 * for the account-scoping rule (remediation D5).
 *
 * Rather than proving that by hand once, this plants each violation in a
 * throwaway file, runs the real lint command, asserts it failed with the
 * expected rule, and removes the file. CI runs it on every merge, so the two
 * enforcement rules can never silently stop working.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

const CASES = [
  {
    name: 'raw @anthropic-ai/sdk import outside packages/llm (invariant 25)',
    file: 'packages/core/src/__lintproof__/raw-sdk-import.ts',
    source: [
      "import Anthropic from '@anthropic-ai/sdk'",
      '',
      'export const client = new Anthropic()',
      '',
    ].join('\n'),
    expectRule: 'sortiva/no-direct-provider-sdk',
  },
  {
    name: 'threshold literal outside packages/rules (invariant 9)',
    file: 'packages/core/src/__lintproof__/threshold-literal.ts',
    source: [
      'export function shouldRefresh(position: number): boolean {',
      '  if (position < 15) {',
      '    return true',
      '  }',
      '  return false',
      '}',
      '',
    ].join('\n'),
    expectRule: 'sortiva/no-threshold-literals',
  },
  {
    name: 'raw table import from @sortiva/db outside packages/db (account scoping, D5)',
    file: 'packages/core/src/__lintproof__/raw-table-import.ts',
    source: [
      "import { db, notifications } from '@sortiva/db'",
      '',
      'export function unscoped() {',
      '  return db().select().from(notifications)',
      '}',
      '',
    ].join('\n'),
    expectRule: 'sortiva/no-raw-db-access',
  },
  {
    name: 'raw schema-module import outside packages/db (account scoping, D5)',
    file: 'packages/core/src/__lintproof__/raw-schema-module.ts',
    source: ["import * as tables from '@sortiva/db/schema'", '', 'export default tables', ''].join('\n'),
    expectRule: 'sortiva/no-raw-db-access',
  },
  {
    // R2 / audit `docs/audits/T0.5.md` finding 9. DataForSEO has no SDK to ban,
    // so the sibling rule cannot see it; the host string is the thing fenced in.
    name: 'direct api.dataforseo.com call outside the SEO wrapper (invariant 25)',
    file: 'packages/llm/src/__lintproof__/dataforseo-host.ts',
    source: [
      'export async function keywordVolume(keyword: string): Promise<Response> {',
      "  return fetch('https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live', {",
      "    method: 'POST',",
      '    body: JSON.stringify([{ keywords: [keyword] }]),',
      '  })',
      '}',
      '',
    ].join('\n'),
    expectRule: 'sortiva/no-direct-vendor-http',
  },
]

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
