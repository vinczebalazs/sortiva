/**
 * Turning what Stripe charges into something a person reads.
 *
 * No amount is written down anywhere in this codebase — Stripe is the only
 * source of truth for what the plan costs, which is what makes repricing a
 * change in Stripe rather than a deploy. So the plan screen is handed a number
 * of minor units (cents, pence, øre) and a currency code, and formats them
 * here.
 *
 * Formatting is left to the browser's own locale rather than the interface
 * language, because a price is read in the conventions of wherever the reader
 * is, and the API deliberately bakes in no locale of its own.
 */

export interface Amount {
  /** Cents, or the currency's smallest unit. Null for a price with no fixed amount. */
  readonly unitAmountMinor: number | null
  /** ISO 4217, lower-case, as Stripe returns it. */
  readonly currency: string
}

/**
 * Currencies whose smallest unit is the unit itself — a price of 500 JPY is
 * ¥500, not ¥5.00. Anything not listed is assumed to have two decimals, which
 * is true of every currency the plan is likely to be sold in.
 */
const ZERO_DECIMAL_CURRENCIES = new Set([
  'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg',
  'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf',
])

export function formatAmount(amount: Amount, locales?: string | readonly string[]): string | null {
  if (amount.unitAmountMinor === null) return null
  const currency = amount.currency.toUpperCase()
  const decimals = ZERO_DECIMAL_CURRENCIES.has(amount.currency.toLowerCase()) ? 0 : 2
  const major = amount.unitAmountMinor / 10 ** decimals

  try {
    return new Intl.NumberFormat(locales as string | string[] | undefined, {
      style: 'currency',
      currency,
      // A plan price is a round figure; trailing `.00` is noise on a pricing
      // card, but a price that genuinely has cents must still show them.
      minimumFractionDigits: Number.isInteger(major) ? 0 : decimals,
      maximumFractionDigits: decimals,
    }).format(major)
  } catch {
    // An unknown currency code must not take the pricing card down with it.
    return `${major} ${currency}`
  }
}
