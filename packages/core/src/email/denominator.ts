/**
 * The monthly summary reports what happened. It never reports it against a
 * target.
 *
 * The product sells "up to 1 article per day, quality permitting" — a ceiling,
 * not a promise. The moment a summary says "22 of 30" it has turned a ceiling
 * into a shortfall, and a month in which the quality bar held eight topics back
 * reads as a month in which we underdelivered. That is the opposite of what
 * holding them back was for.
 *
 * So the rule is enforced on the rendered words, not trusted to whoever writes
 * the next template: no slash, no "of", no target vocabulary. It is stricter
 * than the harm requires, deliberately — "top of the list" is harmless and
 * still rejected, because a checkable rule that a writer works around by
 * rephrasing is worth more than a subtle one that needs judgement every time.
 */

export class DenominatorError extends Error {
  constructor(
    readonly finding: string,
    readonly excerpt: string,
  ) {
    super(`${finding} — in: "${excerpt}"`)
    this.name = 'DenominatorError'
  }
}

/**
 * A link is not a count. `https://sortiva.app/settings` has two slashes and
 * says nothing about how much we published, so URLs come out before the text is
 * judged.
 */
const URL_PATTERN = /https?:\/\/\S+/g

interface Check {
  readonly pattern: RegExp
  readonly finding: string
}

const CHECKS: readonly Check[] = [
  { pattern: /\//, finding: 'a slash, which reads as a fraction' },
  { pattern: /\bof\b/i, finding: '"of", which is how "22 of 30" is written' },
  { pattern: /\bout\s+of\b/i, finding: '"out of"' },
  {
    pattern: /\b(target|quota|goal|expected|allowance|entitlement|remaining|left\s+this\s+month)\b/i,
    finding: 'target vocabulary',
  },
  { pattern: /\b\d+\s*(?:\/|÷)\s*\d+\b/, finding: 'a written-out fraction' },
  { pattern: /\b\d+\s+(?:in|from)\s+\d+\b/, finding: 'a count stated against a total' },
  { pattern: /\b(?:only|just)\s+\d+\b/i, finding: 'a count framed as a shortfall' },
]

/** The excerpt around a match, so the failure names the sentence, not the file. */
function excerptAround(text: string, index: number): string {
  const start = Math.max(0, index - 40)
  return text.slice(start, Math.min(text.length, index + 40)).replace(/\s+/g, ' ').trim()
}

export function findDenominator(text: string): DenominatorError | undefined {
  const withoutUrls = text.replace(URL_PATTERN, ' ')
  for (const check of CHECKS) {
    const match = check.pattern.exec(withoutUrls)
    if (match) return new DenominatorError(check.finding, excerptAround(withoutUrls, match.index))
  }
  return undefined
}

/** Throws on the first finding. Called by the summary's own render, not only by its test. */
export function assertNoDenominator(text: string): void {
  const found = findDenominator(text)
  if (found) throw found
}

/**
 * The weaker rule, for every other template. A reminder may legitimately say
 * "one of your articles"; none of them may state a count against a total.
 */
const NUMERIC_ONLY: readonly Check[] = CHECKS.filter((check) =>
  /\\d/.test(check.pattern.source),
).concat({ pattern: /\b\d+\s+of\s+\d+\b/i, finding: 'a count stated against a total' })

export function assertNoNumericDenominator(text: string): void {
  const withoutUrls = text.replace(URL_PATTERN, ' ')
  for (const check of NUMERIC_ONLY) {
    const match = check.pattern.exec(withoutUrls)
    if (match) throw new DenominatorError(check.finding, excerptAround(withoutUrls, match.index))
  }
}
