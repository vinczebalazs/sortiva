import { SIGNAL_TYPES, type SignalType, type SignalsConfig } from '@sortiva/rules'

/**
 * What a store without a Search Console connection is not being told, and why.
 *
 * Half of what the engine notices comes from Google's own record of what it
 * showed this store: which pages are nearly on the first page, which rank but
 * are not clicked, which are slipping, which of the store's pages are splitting
 * one search. None of that can be inferred — a vendor's sample of a domain is
 * an estimate of positions, not a record of impressions — so those signals do
 * not run rather than run on guesses.
 *
 * The rest still works: what the catalogue sells, what competitors rank for,
 * what the store's own pages say. That is why the mode is called limited rather
 * than off. The merchant is shown a badge naming exactly which signals are
 * unavailable, which is what this list is for, and every opportunity produced
 * in this mode carries a confidence penalty so a guess never presents itself
 * with the authority of a measurement.
 */

/** Signals that cannot fire at all without Search Console, in the config's own order. */
export function signalsNeedingSearchConsole(config: SignalsConfig): readonly SignalType[] {
  return SIGNAL_TYPES.filter((type) => config[type]?.needs_gsc === true)
}

/** Signals that still run for a store with no Search Console connection. */
export function signalsWithoutSearchConsole(config: SignalsConfig): readonly SignalType[] {
  return SIGNAL_TYPES.filter((type) => config[type] !== undefined && config[type].needs_gsc !== true)
}

/**
 * Whether a given signal may be evaluated for this store at all.
 *
 * Asked once per detector by the scan rather than defended against inside each
 * one, so a detector stays a function of its inputs and the reason a signal
 * produced nothing is a decision somebody can see rather than an empty result.
 */
export function signalRuns(
  config: SignalsConfig,
  signalType: SignalType,
  limitedIntelligence: boolean,
): boolean {
  const signal = config[signalType]
  if (!signal) return false
  if (signal.priority !== 'P0') return false
  return !(limitedIntelligence && signal.needs_gsc)
}
