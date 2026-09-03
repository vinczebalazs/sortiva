import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The weekly signal scan never fetches a web page and never calls a model.
 *
 * Every detector it runs is arithmetic over rows already gathered, and the one
 * signal that rests on something expensive — the comparison of a store's page
 * against the pages outranking it — is bought by a scheduled pass of its own
 * and only read here. That separation is the whole reason the two are separate
 * jobs: a page that takes thirty seconds to answer, or a model that is having
 * an outage, must delay that pass and nothing else. Put either back inside this
 * scan and one store's slow competitor holds up every other signal for that
 * store, on the run the merchant is waiting on.
 *
 * It is easy to undo by accident, because the expensive function is one import
 * away in the same package and calling it would look like a tidy-up. This is
 * what stops that being a silent change.
 */

const here = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = join(here, '..', '..', '..', '..')
const SCAN = join(repoRoot, 'packages', 'jobs', 'src', 'scan')

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

/**
 * Buying a results page is deliberately absent from this list: the scan does
 * hold a DataForSEO budget for competitor coverage, through the provider
 * interface and its own `allowSerpSpend` switch. What it must never acquire is
 * the ability to read an arbitrary web page or to ask a model a question.
 */
const FORBIDDEN: readonly (readonly [label: string, pattern: RegExp])[] = [
  ['a page fetcher', /\bPageFetcher\b|\bpageFetcher\b|\bGuardedPageFetcher\b/],
  ['a model client', /\bLlmClient\b|\bllm\.complete\b|@sortiva\/llm\b|@anthropic-ai\/sdk/],
  ['the paid page comparison', /\banalyseIntentGap\b|\bscanIntentGaps\b|\banalyseCoverage\b|\bbuildCoverageRequest\b/],
]

describe('the weekly scan buys no page reads and no model calls', () => {
  // This file names every forbidden thing by definition; the test beside it
  // plants what the paying pass leaves behind and so names them too.
  const files = sourceFiles(SCAN).filter(
    (file) => !file.endsWith('no-paid-work.test.ts') && !file.endsWith('intent-gap.test.ts'),
  )

  it('has the scan code to check', () => {
    expect(files.length, `nothing found under ${SCAN}`).toBeGreaterThan(0)
  })

  for (const [label, pattern] of FORBIDDEN) {
    it(`contains no reference to ${label}`, () => {
      const offenders = files.filter((file) => pattern.test(readFileSync(file, 'utf8')))
      expect(offenders.map((file) => relative(repoRoot, file))).toEqual([])
    })
  }
})
