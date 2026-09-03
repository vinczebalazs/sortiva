import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
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
  StubOpportunitySource: {
    symbol: 'DbOpportunitySource',
    why: 'the onboarding scan’s calendar-seeding step (packages/jobs/src/scan/onboarding.ts) builds it and calls acceptedContentOpportunities(), and that step is registered as the signal_scan_onboarding_sweep crontab task, so a confirmed account really reaches this seam in production',
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

/** Which of them the report actually constructs, which is what puts one on the list. */
function stubsOnTheReport(): string[] {
  const report = readFileSync(join(repoRoot, 'scripts', 'stub-report.mjs'), 'utf8')
  return [...report.matchAll(/new doubles\.(Stub\w+)\(/g)].map((m) => m[1]!)
}

/**
 * Files that build this class, ignoring the one that declares it — a class
 * constructing itself in a helper says nothing about whether the product uses
 * it.
 */
function constructionSites(symbol: string): string[] {
  return productionFiles.filter((file) => {
    const text = readFileSync(file, 'utf8')
    if (!text.includes(`new ${symbol}(`)) return false
    return !text.includes(`export class ${symbol}`)
  })
}

describe('a seam may only leave the stub report by being wired for real', () => {
  const unlisted = everyStub().filter((stub) => !stubsOnTheReport().includes(stub))

  it('finds both the stubs and the report, so the comparison means something', () => {
    expect(everyStub().length).toBeGreaterThan(3)
    expect(stubsOnTheReport().length).toBeGreaterThan(0)
    expect(productionFiles.length).toBeGreaterThan(100)
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

  it('catches the exact case that got past the report', () => {
    // The change stream: recorded by the product, read by nothing. It is back on
    // the report, and this asserts the reason it belongs there still holds.
    expect(constructionSites('DatabaseCatalogEvents')).toEqual([])
    expect(stubsOnTheReport()).toContain('StubCatalogEvents')
  })
})
