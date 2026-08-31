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
 * That ledger is the `job_steps` rows themselves (DECISIONS 2026-08-27 T0.4).
 * So those rows are not a log of what happened — they are the *evidence* that
 * paid work was already done. Delete one and a replay does the work again for
 * real: a re-billed Shopify crawl for `catalog_sync`, a re-billed set of LLM
 * calls for `distill`.
 *
 * Nothing deletes them today. Three things could make someone start: the
 * retention sweep is a registered cron entry with no handler yet, so whoever
 * writes it will be shopping for tables to prune; `job_dlq.step_id` is
 * `ON DELETE set null`, which reads as "deleting steps is expected"; and a
 * "restart onboarding" feature would naturally delete the old run.
 *
 * This file is the tripwire. It is the cheap half of the fix — the durable half
 * is a ledger table with no foreign key to jobs at all, which needs a migration
 * and a founder decision (audit T0.4 [major]; remediation "Still open").
 */

const LEDGER_TABLES = ['job_steps', 'ingestion_jobs']

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
function deletionPaths(source: string, table: string): string[] {
  const drizzleName = table === 'job_steps' ? 'jobSteps' : 'ingestionJobs'
  const patterns: RegExp[] = [
    new RegExp(`\\.delete\\(\\s*${drizzleName}\\s*\\)`, 'g'),
    new RegExp(`delete\\s+from\\s+"?${table}"?`, 'gi'),
    new RegExp(`truncate\\s+(table\\s+)?[^;\\n]*\\b${table}\\b`, 'gi'),
    new RegExp(`drop\\s+table\\s+[^;\\n]*\\b${table}\\b`, 'gi'),
  ]
  return patterns.flatMap((pattern) => source.match(pattern) ?? [])
}

describe('the idempotency ledger is never deleted (main §14.3.2)', () => {
  const files = sourceFiles()

  it('scans a plausible amount of source, so a passing result means something', () => {
    expect(files.length).toBeGreaterThan(20)
  })

  for (const table of LEDGER_TABLES) {
    it(`no production code path deletes rows from ${table}`, () => {
      const offenders = files
        .map((file) => ({ file, hits: deletionPaths(readFileSync(join(REPO_ROOT, file), 'utf8'), table) }))
        .filter((r) => r.hits.length > 0)
        .map((r) => `${r.file}: ${r.hits.join(', ')}`)

      expect(
        offenders,
        `${table} rows are the record of which paid work has already been done (main §14.3.2). ` +
          `Deleting one lets a replay re-run that work and re-bill for it. If a run really must be ` +
          `discarded, the ledger has to move to its own table first — that is a schema-wave change ` +
          `and a founder decision, not something to unblock by deleting here.`,
      ).toEqual([])
    })
  }

  it('the scan would actually catch a deletion', () => {
    // The detector under test, rather than trusting a green result from it.
    expect(deletionPaths('await db.delete(jobSteps).where(x)', 'job_steps')).not.toEqual([])
    expect(deletionPaths("pool.query('DELETE FROM job_steps')", 'job_steps')).not.toEqual([])
    expect(deletionPaths('await db.delete(ingestionJobs)', 'ingestion_jobs')).not.toEqual([])
    expect(deletionPaths('await db.update(jobSteps).set({})', 'job_steps')).toEqual([])
  })

  it('the retention sweep is told in writing that these tables are never prunable', () => {
    const sweep = CRON_ENTRIES.find((entry) => entry.task === 'retention_sweep_daily')
    expect(sweep, 'the retention sweep is no longer registered').toBeDefined()
    for (const table of LEDGER_TABLES) {
      expect(sweep!.spec).toContain(table)
    }
    expect(sweep!.spec).toContain('NEVER PRUNABLE')
  })

  it('nothing but the account cascade can reach these rows through a foreign key', () => {
    const dir = join(REPO_ROOT, 'packages/db/migrations')
    const sql = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => readFileSync(join(dir, f), 'utf8'))
      .join('\n')

    // Constraints declared *on* the ledger tables: a cascade here means deleting
    // the parent deletes ledger rows. Two are expected and correct — a step
    // belongs to its run, a run belongs to its account, and §14.6 deletes an
    // account's data outright. A third would be a new way to lose the ledger.
    const cascades = [...sql.matchAll(/ALTER TABLE "([a-z_]+)"[^;]*?REFERENCES "public"\."([a-z_]+)"[^;]*?ON DELETE cascade/g)]
      .map(([, child, parent]) => `${child} -> ${parent}`)
      .filter((edge) => LEDGER_TABLES.some((t) => edge.startsWith(`${t} `)))

    expect(cascades.sort()).toEqual(['ingestion_jobs -> accounts', 'job_steps -> ingestion_jobs'])
  })
})
