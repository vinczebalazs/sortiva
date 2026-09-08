import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * A merchant's competitor list is written by the merchant. Nothing in the
 * product puts a domain on it.
 *
 * Why this needs a scan rather than a promise. A domain that turns up in search
 * results is a domain that turns up in search results: a publisher, a forum, a
 * marketplace and a supplier all rank, and none of them is necessarily somebody
 * the merchant would call a competitor. Filling their list in for them states
 * something about their business on their behalf — and it also spends their
 * money, because the length of that list is what we pay the search-data vendor
 * per store, every week, for as long as they are a customer.
 *
 * Onboarding used to write up to five rows before the merchant had seen
 * anything. That was noticed when it was built, argued about in the decision
 * journal, and left standing for five days, because **prose in two files is not
 * a mechanism**. This is the mechanism: the only code that may add a competitor
 * is the code handling a request the merchant made.
 *
 * The suggestions themselves are not stored at all. They are recomputed from
 * the stored results pages whenever the screen is opened, so there is no
 * half-accepted state anywhere and nothing to clean up if the merchant ignores
 * them.
 */

const here = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = join(here, '..', '..', '..', '..')

/**
 * Where a competitor row may legitimately be written, and why each one is
 * allowed. Anything else is the defect this test exists to catch.
 */
const PERMITTED = [
  // The repository function itself, and the barrel that re-exports it.
  join('packages', 'db', 'src', 'repositories', 'keywords.ts'),
  join('packages', 'db', 'src', 'index.ts'),
  // The narrow interface the request handler is given, which forwards to it.
  join('packages', 'db', 'src', 'stores', 'keywords.ts'),
  // The merchant's click: `POST /api/profile/competitors`.
  join('apps', 'web', 'app', 'api', 'profile'),
]

/** The call, not the word — a comment or a type import naming it is not a write. */
const WRITE_CALL = /\baddCompetitor\s*\(/

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === 'dist') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.tsx?$/.test(entry) && !entry.endsWith('.d.ts')) out.push(full)
  }
  return out
}

const allFiles = [join(repoRoot, 'packages'), join(repoRoot, 'apps')].flatMap(sourceFiles)

/** Tests may add competitors freely; they are describing situations, not creating them. */
const productionFiles = allFiles.filter((file) => !/\.(test|spec)\.tsx?$/.test(file))

describe('invariant 5 — a competitor is added by the merchant, never by us', () => {
  it('has the whole workspace in view (the scan is not vacuously empty)', () => {
    expect(productionFiles.length).toBeGreaterThan(50)
    // Named directories rather than a count alone: a scan that quietly stopped
    // descending into the job steps would still pass a count, and the job steps
    // are where the defect was.
    expect(productionFiles.some((f) => f.includes(join('packages', 'jobs', 'src', 'ingestion')))).toBe(true)
    expect(productionFiles.some((f) => f.includes(join('apps', 'web', 'app', 'api')))).toBe(true)
  })

  it('is looking for something that exists (the pattern still matches the real call)', () => {
    const store = readFileSync(join(repoRoot, 'packages', 'db', 'src', 'stores', 'keywords.ts'), 'utf8')
    expect(WRITE_CALL.test(store)).toBe(true)
  })

  it('no job, sweep or background step adds a competitor', () => {
    const writers = productionFiles
      .filter((file) => WRITE_CALL.test(readFileSync(file, 'utf8')))
      .map((file) => relative(repoRoot, file))
      .filter((file) => !PERMITTED.some((allowed) => file.startsWith(allowed)))

    expect(writers).toEqual([])
  })

  /**
   * The narrower half of the same rule: domains seen in search results live in
   * the stored results pages and are never copied across. A step that read a
   * snapshot and wrote a competitor row would be caught above; this catches the
   * ingestion step going back to writing them at all.
   */
  it('the discovery step reads results pages and writes no competitor', () => {
    const step = readFileSync(
      join(repoRoot, 'packages', 'jobs', 'src', 'ingestion', 'keywords.ts'),
      'utf8',
    )
    expect(step).toMatch(/rankCompetitorCandidates/)
    expect(WRITE_CALL.test(step)).toBe(false)
  })
})
