import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Invariant 16 — `subscriptions.status` has **exactly one writer**, the Stripe
 * webhook worker. Everything in the product that asks "may this account
 * generate or publish" reads the row that worker maintains.
 *
 * The whole billing design rests on that being true, and nothing was checking
 * it: the T1.2 audit planted a second writer to `subscriptions` in an unrelated
 * file and all 464 tests passed. A second writer does not fail loudly — it
 * produces an account whose entitlement flips depending on which code path ran
 * last, which looks like a Stripe bug and is not.
 *
 * Written in the same style as `stripeCallSites.test.ts`, which scans source
 * text rather than trusting types, because the hazard is a *new* file that no
 * existing type mentions. Like that test, this one carries its own
 * anti-vacuity check: a scanner that has stopped seeing the sanctioned writer
 * would pass silently while proving nothing.
 */

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))

/**
 * The one binding allowed to write the table, plus the port that declares the
 * write and the in-memory double that stands in for it in tests.
 */
const WRITERS_ALLOWED = [
  // The guarded upsert itself — the single writer (invariant 16).
  'apps/web/app/api/billing/_lib/store.ts',
  // The port declaring `writeSubscription`; no SQL, but it names the table.
  'packages/core/src/billing/store.ts',
  // The in-memory double implementing that port for tests.
  'packages/core/src/billing/testing.ts',
  // Schema definition and migrations are not writers.
  'packages/db/src/schema/accounts.ts',
]

const SCAN_ROOTS = ['packages', 'apps']
const SKIP_DIRECTORIES = new Set(['node_modules', '.next', 'dist', 'coverage', '.turbo'])

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRECTORIES.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

const files = SCAN_ROOTS.flatMap((root) => sourceFiles(join(repoRoot, root))).map((file) =>
  relative(repoRoot, file).split('\\').join('/'),
)

function isTest(path: string): boolean {
  return /\.(test|spec)\.tsx?$/.test(path)
}

function allowed(path: string): boolean {
  return WRITERS_ALLOWED.some((prefix) => path === prefix || path.startsWith(prefix))
}

/**
 * Raw SQL that writes the table: `INSERT INTO subscriptions`,
 * `UPDATE subscriptions`, `DELETE FROM subscriptions`, and the drizzle
 * equivalents `.insert(subscriptions)`, `.update(subscriptions)`,
 * `.delete(subscriptions)`.
 */
const WRITE_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  { name: 'INSERT INTO subscriptions', pattern: /insert\s+into\s+"?subscriptions"?/i },
  { name: 'UPDATE subscriptions', pattern: /update\s+"?subscriptions"?\s+set/i },
  { name: 'DELETE FROM subscriptions', pattern: /delete\s+from\s+"?subscriptions"?/i },
  // `(?:\w+\.)*` so a qualified reference — `schema.subscriptions`,
  // `s.subscriptions` — is caught too. Without it the first planted writer
  // tried against this test walked straight through.
  { name: 'drizzle .insert(subscriptions)', pattern: /\.insert\(\s*(?:\w+\.)*subscriptions\s*\)/ },
  { name: 'drizzle .update(subscriptions)', pattern: /\.update\(\s*(?:\w+\.)*subscriptions\s*\)/ },
  { name: 'drizzle .delete(subscriptions)', pattern: /\.delete\(\s*(?:\w+\.)*subscriptions\s*\)/ },
]

function writesIn(source: string): string[] {
  return WRITE_PATTERNS.filter(({ pattern }) => pattern.test(source)).map(({ name }) => name)
}

describe('`subscriptions` has exactly one writer (invariant 16)', () => {
  it('finds source files to check', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it('no file outside the billing store writes the subscriptions table', () => {
    const offenders: string[] = []
    for (const path of files) {
      if (isTest(path) || allowed(path)) continue
      const found = writesIn(readFileSync(join(repoRoot, path), 'utf8'))
      for (const name of found) offenders.push(`${path}: ${name}`)
    }
    expect(offenders).toEqual([])
  })

  it('nothing outside the billing module implements the write port', () => {
    // A second implementation of `BillingStore` would be a second writer that
    // no SQL pattern above would catch, because it would go through drizzle in
    // a file that never names the table directly.
    //
    // Only *implementations* count: `implements BillingStore` on a class, or a
    // function/const annotated as returning one. Merely holding a `BillingStore`
    // — which the worker does, as a dependency — is consumption, not writing.
    const offenders = files.filter((path) => {
      if (isTest(path) || allowed(path)) return false
      return /implements\s+BillingStore\b|\)\s*:\s*BillingStore\b|:\s*BillingStore\s*=/.test(
        readFileSync(join(repoRoot, path), 'utf8'),
      )
    })
    expect(offenders).toEqual([])
  })

  it('the rule is not vacuous — it does see the sanctioned writer', () => {
    // If this fails, the store was renamed or moved and the scan above is now
    // watching an empty room: every assertion would pass while a second writer
    // sat in the codebase unnoticed.
    const store = 'apps/web/app/api/billing/_lib/store.ts'
    expect(files).toContain(store)
    const found = writesIn(readFileSync(join(repoRoot, store), 'utf8'))
    expect(found).toContain('INSERT INTO subscriptions')
  })

  it('the patterns actually match a write when they see one', () => {
    // Proves the regexes themselves, not just the corpus: a typo that made
    // every pattern unmatchable would otherwise look like a clean codebase.
    expect(writesIn('await db.execute(sql`INSERT INTO subscriptions (account_id) ...`)')).toContain(
      'INSERT INTO subscriptions',
    )
    expect(writesIn('await db.update(subscriptions).set({ status })')).toContain(
      'drizzle .update(subscriptions)',
    )
    // The qualified form. This is the shape of the writer the T1.2 audit
    // planted, and the first version of this test did not catch it.
    expect(writesIn("await db().update(schema.subscriptions).set({ status: 'active' })")).toContain(
      'drizzle .update(subscriptions)',
    )
    expect(writesIn('await db.insert(schema.subscriptions).values(row)')).toContain(
      'drizzle .insert(subscriptions)',
    )
    expect(writesIn('const x = 1')).toEqual([])
    // Reading is not writing.
    expect(writesIn('await db.select().from(schema.subscriptions)')).toEqual([])
  })
})
