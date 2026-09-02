/**
 * How a stored results page is addressed.
 *
 * Ours, not the vendor's. The vendor's own request cache is keyed on its
 * endpoint and its parameter hash and lives for a day; this key is what the
 * product means by "the results for this search, in this market, to this
 * depth", and it lives for a week. Keeping them separate is deliberate: one
 * makes a crashed step's retry free, the other is the product's memory, and
 * conflating them would put a crash-safety mechanism in charge of how current
 * our view of a results page is.
 *
 * It carries no account. Two stores selling into the same market and asking
 * about the same search share one purchase.
 */

export interface SerpLocaleKey {
  /** ISO-639-1, e.g. `da`. */
  readonly language: string
  /** ISO-3166 alpha-2, e.g. `DK`. */
  readonly country: string
}

/** `da-DK` — the form stored on the snapshot row and shown in logs. */
export function serpLocaleTag(locale: SerpLocaleKey): string {
  return `${locale.language.trim().toLowerCase()}-${locale.country.trim().toUpperCase()}`
}

/**
 * The same search asked twice must produce one key, so the query is normalised
 * exactly as a stored keyword is: trimmed, lower-cased, whitespace collapsed.
 * Depth is part of the identity because a page of ten results cannot answer a
 * question about twenty.
 */
export function serpSnapshotKey(input: {
  query: string
  locale: SerpLocaleKey
  depth: number
}): string {
  const query = input.query.trim().toLowerCase().replace(/\s+/g, ' ')
  return `serp:${serpLocaleTag(input.locale)}:${input.depth}:${query}`
}
