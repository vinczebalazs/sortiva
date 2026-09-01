import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CRON_ENTRIES } from './crontab'

/**
 * main §14.3.2 — "Completed keys are stored with their output reference; a
 * worker seeing a completed key returns the stored output without executing.
 * This makes the *cache the ledger*: 'have I done this work' and 'where is the
 * result' are the same lookup."
 *
 * That record is not a log of what happened — it is the *evidence* that paid
 * work was already done. Delete it and a redelivered message does the work again
 * for real: a re-billed Shopify crawl for `catalog_sync`, a re-billed set of LLM
 * calls for `distill`.
 *
 * **What changed under card R3.** The evidence used to be the `job_steps` rows
 * themselves, and this file used to forbid deleting them (DECISIONS 2026-08-31
 * R1 — the cheap half of the fix, taken while the durable half was undecided).
 * It now lives in `idempotency_ledger`, a table with no foreign key to anything,
 * so no cascade can reach it. The tripwire keeps its job and changes its target:
 * job rows are ordinary state again and may be deleted — a "restart onboarding"
 * feature is now free to — while the ledger is the thing nothing may delete.
 *
 * Not asserted here because it is asserted better elsewhere: that the ledger has
 * no foreign key and refuses `UPDATE`. `packages/db/src/constraints-wave2b.test.ts`
 * proves both against a real Postgres, which beats scanning migration text.
 */

const LEDGER_TABLE = 'idempotency_ledger'
const LEDGER_DRIZZLE_NAME = 'idempotencyLedger'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')

const SEARCH_ROOTS = ['apps', 'packages', 'scripts', 'tools']

const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', '.next', 'coverage', 'migrations'])

/**
 * Test harnesses and dev seeds truncate everything by design; they never run
 * against a real database. The rule is about production code paths.
 */
const EXEMPT = [
  /\.test\.ts$/,
  /\.spec\.ts$/,
  /packages\/db\/src\/testing\.ts$/,
  /packages\/db\/src\/seed\.ts$/,
  /scripts\/seed-dev-db\.mjs$/,
]

function sourceFiles(): string[] {
  const found: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRECTORIES.has(entry)) continue
      const abs = join(dir, entry)
      if (statSync(abs).isDirectory()) {
        walk(abs)
        continue
      }
      if (!/\.(ts|tsx|mjs|js)$/.test(entry)) continue
      const rel = relative(REPO_ROOT, abs).split('\\').join('/')
      if (EXEMPT.some((pattern) => pattern.test(rel))) continue
      found.push(rel)
    }
  }
  for (const root of SEARCH_ROOTS) walk(join(REPO_ROOT, root))
  return found
}

/** Every way this codebase could spell "remove rows from that table". */
function deletionPaths(source: string): string[] {
  const patterns: RegExp[] = [
    new RegExp(`\\.delete\\(\\s*${LEDGER_DRIZZLE_NAME}\\s*\\)`, 'g'),
    new RegExp(`delete\\s+from\\s+"?${LEDGER_TABLE}"?`, 'gi'),
    new RegExp(`truncate\\s+(table\\s+)?[^;\\n]*\\b${LEDGER_TABLE}\\b`, 'gi'),
    new RegExp(`drop\\s+table\\s+[^;\\n]*\\b${LEDGER_TABLE}\\b`, 'gi'),
  ]
  return patterns.flatMap((pattern) => source.match(pattern) ?? [])
}

describe('the idempotency ledger is never deleted (main §14.3.2)', () => {
  const files = sourceFiles()

  it('scans a plausible amount of source, so a passing result means something', () => {
    expect(files.length).toBeGreaterThan(20)
  })

  it(`no production code path deletes rows from ${LEDGER_TABLE}`, () => {
    const offenders = files
      .map((file) => ({ file, hits: deletionPaths(readFileSync(join(REPO_ROOT, file), 'utf8')) }))
      .filter((r) => r.hits.length > 0)
      .map((r) => `${r.file}: ${r.hits.join(', ')}`)

    expect(
      offenders,
      `${LEDGER_TABLE} rows are the record of which paid work has already been done (main §14.3.2). ` +
        `Deleting one lets a redelivered job re-run that work and re-bill for it. The retention sweep ` +
        `tech §2.1 anticipates may prune this table by AGE, well past the point where the queue could ` +
        `still redeliver — never by job, never by account, and never as part of deleting a store. If ` +
        `that sweep is what you are writing, change this test deliberately and record it in DECISIONS.`,
    ).toEqual([])
  })

  it('the scan would actually catch a deletion', () => {
    // The detector under test, rather than trusting a green result from it.
    expect(deletionPaths('await db.delete(idempotencyLedger).where(x)')).not.toEqual([])
    expect(deletionPaths("pool.query('DELETE FROM idempotency_ledger')")).not.toEqual([])
    expect(deletionPaths('TRUNCATE TABLE "idempotency_ledger" CASCADE')).not.toEqual([])
    expect(deletionPaths('await db.insert(idempotencyLedger).values(x)')).toEqual([])
  })

  it('the retention sweep is told in writing how this table may be pruned', () => {
    const sweep = CRON_ENTRIES.find((entry) => entry.task === 'retention_sweep_daily')
    expect(sweep, 'the retention sweep is no longer registered').toBeDefined()
    expect(sweep!.spec).toContain(LEDGER_TABLE)
    expect(sweep!.spec).toContain('PRUNE BY AGE ONLY')
  })

  it('the runtime reads the ledger table, not the job rows it used to read', () => {
    // The regression this card exists to prevent: a completed-work lookup that
    // reads `job_steps` is only as durable as the run it belongs to.
    const runStep = readFileSync(join(REPO_ROOT, 'packages/jobs/src/runtime/runStep.ts'), 'utf8')
    expect(runStep).toContain('lookupCompletedWork')
    expect(runStep).not.toContain('lookupCompletedKey(')

    const steps = readFileSync(join(REPO_ROOT, 'packages/jobs/src/runtime/steps.ts'), 'utf8')
    expect(
      /select\([^)]*jobSteps\.outputRef/.test(steps),
      'steps.ts is reading a completed step’s output again; that is the deletable ledger this card removed',
    ).toBe(false)
  })
})
