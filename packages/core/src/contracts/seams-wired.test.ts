import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * `pnpm stubs:report` lists every seam the product is still running on a
 * stand-in, and a milestone gate fails while one of its seams is on that list.
 * A seam leaves the list by having its line deleted from the script — a
 * judgement call, made by hand, checked by nobody.
 *
 * That is how the change stream came to be reported as done. Its line was
 * removed with a note saying it "is served in production by
 * `DatabaseCatalogEvents`", which was not true: the class was constructed
 * nowhere outside its own test, the drain job was registered nowhere, and
 * milestone 2's exit gate passed partly on that sentence.
 *
 * So this is the missing check. A seam may be dropped from the report only when
 * its real implementation is genuinely constructed somewhere that is not a
 * test. Removing a line without wiring anything now fails here instead of
 * quietly passing a gate.
 */

const here = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = join(here, '..', '..', '..', '..')

/**
 * For each seam allowed off the report, the class that must be built for real,
 * and why we believe it is. The reason is not decoration: it is what a reader
 * checks the code against when this test fails.
 */
const REAL_IMPLEMENTATION: Record<string, { symbol: string; why: string }> = {
  StubExistingTargetCheck: {
    symbol: 'DbExistingTargetCheck',
    why: 'the calendar’s add-topic route builds it, so a typed topic is checked against pages we already have',
  },
  StubNotificationEmitter: {
    symbol: 'DbNotificationEmitter',
    why: 'the Shopify composition root hands this out, so a notification reaches a real row rather than a stand-in',
  },
  StubJudgeLite: {
    symbol: 'LlmJudgeLite',
    why: 'the improve-this-page worker builds it unconditionally and the composition root (apps/web/instrumentation-node.ts) registers that worker, so a merchant’s click is graded by the real judge rather than by a stand-in that passes everything',
  },
  StubCatalogEvents: {
    symbol: 'DatabaseCatalogEvents',
    why: 'the composition root (apps/web/instrumentation-node.ts) builds it and hands it to the registered catalogue-change drain, and the Shopify webhook handler asks for a pass the moment it records a change — so a merchant’s edit really is read in production, which is the half that used to be missing',
  },
  StubOpportunitySource: {
    symbol: 'DbOpportunitySource',
    why: 'the onboarding scan’s calendar-seeding step (packages/jobs/src/scan/onboarding.ts) builds it and calls acceptedContentOpportunities(), and that step is registered as the signal_scan_onboarding_sweep crontab task, so a confirmed account really reaches this seam in production',
  },
  StubTopicScheduler: {
    symbol: 'DbTopicScheduler',
    why: 'three production callers build it — the onboarding scan’s calendar-seeding step, the monthly replenishment job (packages/jobs/src/generation/replenish.ts, registered as the replenishment_monthly crontab task) and the schedule action behind POST /api/opportunities/{id} — so a topic really does reach a calendar in production',
  },
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.next') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sourceFiles(full, out)
    else if (/\.tsx?$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

/** Everything the product ships, minus its tests. */
const productionFiles = ['packages', 'apps'].flatMap((top) => sourceFiles(join(repoRoot, top)))

/** Which seam stand-ins exist at all. */
function everyStub(): string[] {
  const doubles = readFileSync(join(here, 'doubles.ts'), 'utf8')
  return [...doubles.matchAll(/export class (Stub\w+)/g)].map((m) => m[1]!)
}

function reportSource(): string {
  return readFileSync(join(repoRoot, 'scripts', 'stub-report.mjs'), 'utf8')
}

/** Which stand-ins a given report builds, which is what puts one on its list. */
function stubsIn(reportSourceText: string): string[] {
  return [...reportSourceText.matchAll(/new doubles\.(Stub\w+)\(/g)].map((m) => m[1]!)
}

/** Which of them the real report constructs. */
function stubsOnTheReport(): string[] {
  return stubsIn(reportSource())
}

/**
 * Files that build this class, ignoring the one that declares it — a class
 * constructing itself in a helper says nothing about whether the product uses
 * it.
 */
function constructionSites(symbol: string): string[] {
  return productionFiles
    .filter((file) => {
      const text = readFileSync(file, 'utf8')
      if (!text.includes(`new ${symbol}(`)) return false
      return !text.includes(`export class ${symbol}`)
    })
    .map((file) => relative(repoRoot, file))
    .sort()
}

/**
 * The other direction, which nothing checked until a stand-in was found running
 * in the product's money path.
 *
 * Everything above guards *removals*: a seam may not be dropped from the report
 * unless something real replaced it. Nothing guarded the opposite — a stand-in
 * still being built by shipping code. Those two are not the same question, and
 * one seam managed to be both at once: `StubNotificationEmitter` was recorded
 * above as replaced (true of the Shopify path, which is where it was checked)
 * while the Stripe webhook went on building it, unlisted and unreported.
 *
 * So every stand-in must be constructed **nowhere** in shipping code, unless it
 * is recorded here by the exact file that does it. A record is not permission:
 * it is a finding that cannot be forgotten, and it is asserted to still be
 * exactly true, so repairing the wiring turns this file red asking for the
 * record to be deleted.
 */
const WIRED_IN_PRODUCTION: Record<string, { readonly files: readonly string[]; readonly finding: string }> = {}

describe('no stand-in is left running in the product itself', () => {
  it.each(everyStub())('%s is not built by shipping code', (stub) => {
    const recorded = WIRED_IN_PRODUCTION[stub]
    const sites = constructionSites(stub)

    if (!recorded) {
      expect(
        sites,
        `\`${stub}\` is constructed by code that ships. A stand-in reached by a real request ` +
          'does whatever it was written to do for a test — usually nothing — and no report will say so, ' +
          'because the stub report is a hand-written list and this is not on it. Either wire the real ' +
          'implementation, or record this in WIRED_IN_PRODUCTION with what a user loses by it.',
      ).toEqual([])
      return
    }

    expect(
      sites,
      `The recorded finding for \`${stub}\` no longer matches what the code does. If it has been ` +
        `fixed, delete its WIRED_IN_PRODUCTION entry in the same commit. Recorded: ${recorded.finding}`,
    ).toEqual([...recorded.files])
  })

  it('is not vacuous: it would notice a stand-in nobody had recorded', () => {
    // The check above passes trivially if `constructionSites` has stopped
    // finding anything. The recorded finding used to prove it still worked;
    // there are now none, so a class the product certainly does build stands in
    // for that — if this scan cannot see `DbNotificationEmitter`, which every
    // composition root that notifies anybody builds, it would not see a
    // stand-in either.
    expect(constructionSites('DbNotificationEmitter')).not.toEqual([])
  })
})

describe('a seam may only leave the stub report by being wired for real', () => {
  const unlisted = everyStub().filter((stub) => !stubsOnTheReport().includes(stub))

  it('finds both the stubs and the report, so the comparison means something', () => {
    expect(everyStub().length).toBeGreaterThan(3)
    expect(productionFiles.length).toBeGreaterThan(100)

    // This used to require the real report to still be building at least one
    // stand-in. That conflated two things, and they came apart on 2026-09-08
    // when the last one was replaced: an empty list is the goal, not a broken
    // parser. So the parser is proved against a sample, and the report is
    // proved to have been read.
    expect(reportSource()).toContain('wiredStubs')
    expect(stubsIn('new doubles.StubOne()\nnew doubles.StubTwo(capture)')).toEqual(['StubOne', 'StubTwo'])
  })

  it('names a real implementation for every seam kept off the report', () => {
    const unexplained = unlisted.filter((stub) => !(stub in REAL_IMPLEMENTATION))
    expect(
      unexplained,
      'These stand-ins were removed from `pnpm stubs:report` with nothing recorded about ' +
        'what replaced them. Either restore the line in scripts/stub-report.mjs, or add an ' +
        'entry to REAL_IMPLEMENTATION naming the class that does the job in production: ' +
        unexplained.join(', '),
    ).toEqual([])
  })

  it.each(Object.entries(REAL_IMPLEMENTATION))(
    '%s is off the report because %o is actually built in production',
    (stub, { symbol, why }) => {
      // If the stub is back on the report, the claim is no longer being made.
      if (stubsOnTheReport().includes(stub)) return

      expect(
        constructionSites(symbol),
        `\`${symbol}\` is constructed nowhere outside its own definition and its tests, so ` +
          `dropping ${stub} from the stub report claims something untrue. Expected: ${why}.`,
      ).not.toEqual([])
    },
  )

  it('is not vacuous: a class nobody builds is reported as unbuilt', () => {
    expect(constructionSites('DbClassThatDoesNotExist')).toEqual([])
  })

  it('the case that got past the report is now genuinely closed', () => {
    // The change stream is the seam this whole file was written for: it was
    // dropped from the report on a claim that nothing had checked, and for a
    // long time the product recorded what merchants changed and read none of it.
    // Both halves now run, so the claim is finally true — and this asserts the
    // thing itself rather than the bookkeeping, so restoring the report line
    // without unwiring anything would not quietly satisfy it.
    expect(constructionSites('DatabaseCatalogEvents')).not.toEqual([])
  })
})
