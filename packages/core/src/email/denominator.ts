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

/**
 * A quantity, in the two forms our copy can carry one: a literal number, or a
 * placeholder the renderer will fill with one.
 *
 * The placeholder half is why this is a pattern rather than a digit class. The
 * string catalogue is written before anything is rendered, so "{count} of {cap}"
 * is a denominator that has not happened yet, and "3 of 30" is a denominator
 * somebody typed by hand because the numbers were known at the time. Both have
 * to be refused by the same rule, and a check that knew only one of them is what
 * this file exists to stop.
 */
const QUANTITY = String.raw`(?:\d+|\{\w+\})`

/**
 * Words a writer can slip between the two halves without changing the meaning:
 * "12 of your 30" is "12 of 30" with a possessive in the middle.
 */
const FILLER = String.raw`(?:(?:your|the|a|an|our|its|their|this|that|possible|monthly|daily|weekly|total|maximum|available|planned|allowed)\s+)*`

/**
 * Two quantities joined by anything that makes the second one a total: a slash
 * in any of its shapes, or the words that mean the same thing.
 */
const QUANTITY_PAIR = new RegExp(
  `${QUANTITY}(?:\\s*[/⁄÷]\\s*|\\s+(?:out\\s+of|of|in|from)\\s+${FILLER})${QUANTITY}`,
  'i',
)

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
  { pattern: QUANTITY_PAIR, finding: 'a count stated against a total' },
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
 * The weaker rule, for every other template and for the string catalogue.
 *
 * The strict rule above bans the word "of" outright, which the monthly summary
 * can live with and ordinary product copy cannot: "one of your articles" is a
 * perfectly honest sentence. So this list refuses only a count stated against a
 * total — one quantity, a joining word or a slash, another quantity — however
 * the two quantities are written.
 *
 * It used to be the strict list filtered down to whichever patterns mentioned a
 * digit, plus one hand-added `\d+ of \d+`. That knew a quantity only as digits
 * and only with nothing between the halves, so "{count} of {cap}", "3 out of
 * 30" and "12 of your 30" all passed it.
 */
const NUMERIC_CHECKS: readonly Check[] = [
  { pattern: QUANTITY_PAIR, finding: 'a count stated against a total' },
  { pattern: /\b(?:only|just)\s+\d+\b/i, finding: 'a count framed as a shortfall' },
]

export function findNumericDenominator(text: string): DenominatorError | undefined {
  const withoutUrls = text.replace(URL_PATTERN, ' ')
  for (const check of NUMERIC_CHECKS) {
    const match = check.pattern.exec(withoutUrls)
    if (match) return new DenominatorError(check.finding, excerptAround(withoutUrls, match.index))
  }
  return undefined
}

export function assertNoNumericDenominator(text: string): void {
  const found = findNumericDenominator(text)
  if (found) throw found
}
