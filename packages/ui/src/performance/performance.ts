import { t as defaultTranslate, type StringKey, type Translate } from '../strings'
import type {
  MarkerKind,
  PageType,
  PerformanceResult,
  SearchConsoleRow,
  SearchConsoleWindow,
} from './types'

/**
 * What the Performance screens decide before anything is drawn: which rows are
 * shown together and which are held apart, what a verdict is called, and how a
 * change since the last window is worded.
 *
 * Two rules in here are the reason the screen can be trusted at all.
 *
 * **A result with no verdict is early, not bad.** Nothing is judged until the
 * measurement window has passed, so an article published last week has no label
 * and no figures — and the row says "too new to judge" with a dash where its
 * numbers will be. A nought in that space would read as a page nobody visited,
 * which is a different and much worse claim.
 *
 * **Articles published against our recommendation are shown separately.** They
 * are kept out of quality tuning and out of any claim about how our headlines
 * perform, so mixing them into the same table would put numbers we deliberately
 * do not learn from next to numbers we do.
 */

/** How a label is treated, which is not the same as what it is called. */
export type LabelTone = 'good' | 'neutral' | 'poor' | 'unmeasured'

const LABEL_TONES: Readonly<Record<string, LabelTone>> = {
  winner: 'good',
  improved: 'good',
  recovered: 'good',
  neutral: 'neutral',
  underperformer: 'poor',
  worse: 'poor',
  unrated: 'unmeasured',
  not_applied: 'unmeasured',
}

export function labelTone(label: string): LabelTone {
  return LABEL_TONES[label] ?? 'neutral'
}

/**
 * A result we have no verdict for yet. Both cases mean "there is nothing to
 * read here", and both must render as an absence rather than as a nought: an
 * unrated page is too young to judge, and a recommendation nobody marked
 * applied was never carried out, so there is nothing of ours to measure.
 */
export function isUnmeasured(label: string): boolean {
  return labelTone(label) === 'unmeasured'
}

/** The verdict in words. An unknown label is spelled out rather than shown as a code. */
export function resultLabel(label: string, t: Translate = defaultTranslate): string {
  try {
    return t(`performance.label.${label}` as StringKey)
  } catch {
    return humanise(label)
  }
}

export function markerLabel(kind: MarkerKind, t: Translate = defaultTranslate): string {
  return t(`performance.marker.${kind}` as StringKey)
}

export function pageTypeLabel(pageType: PageType, t: Translate = defaultTranslate): string {
  return t(`performance.pageType.${pageType}` as StringKey)
}

export function windowOptionLabel(window: SearchConsoleWindow, t: Translate = defaultTranslate): string {
  return t(`performance.window.${window}` as StringKey)
}

export const SEARCH_CONSOLE_WINDOWS: readonly SearchConsoleWindow[] = ['28d', '3m', '12m']

function humanise(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/^./, (character) => character.toUpperCase())
}

// ── The results table ───────────────────────────────────────────────────────

export interface SplitResults {
  /** Everything measured the ordinary way. */
  readonly rows: readonly PerformanceResult[]
  /**
   * Articles the merchant published against our recommendation. Held apart
   * because they are excluded from calibration and from every claim we make
   * about how our own writing performs.
   */
  readonly overridden: readonly PerformanceResult[]
}

export function splitResults(results: readonly PerformanceResult[]): SplitResults {
  return {
    rows: results.filter((result) => !result.publishedViaOverride),
    overridden: results.filter((result) => result.publishedViaOverride),
  }
}

/**
 * How a figure on a results row is written.
 *
 * Deliberately returns null rather than a zero for a row with no verdict yet:
 * the caller renders an em dash, and the difference between "nobody came" and
 * "we have not looked yet" survives all the way to the screen.
 */
export function resultFigure(result: PerformanceResult, measure: 'clicks' | 'impressions' | 'position'): number | null {
  if (isUnmeasured(result.label)) return null
  if (measure === 'clicks') return result.clicks
  if (measure === 'impressions') return result.impressions
  return result.position
}

/** Counts of each verdict across the rated results, for the label breakdown. */
export function labelCounts(results: readonly PerformanceResult[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {}
  for (const result of results) {
    if (isUnmeasured(result.label)) continue
    counts[result.label] = (counts[result.label] ?? 0) + 1
  }
  return counts
}

// ── Deltas on the Search Console tables ─────────────────────────────────────

export type DeltaDirection = 'up' | 'down' | 'flat'

export interface Delta {
  readonly direction: DeltaDirection
  /** The change as the merchant should read it, sign and all. */
  readonly text: string
  /** Whether the change is in the merchant's favour, which is not the same as its sign. */
  readonly favourable: boolean | null
}

/**
 * A change in clicks reads the obvious way; a change in position does not.
 * Moving from position 12 to position 8 arrives as −4 and is an improvement, so
 * the arrow and the wording are decided from what the number means rather than
 * from its sign.
 */
export function clicksDelta(delta: number, t: Translate = defaultTranslate): Delta {
  if (delta === 0) return { direction: 'flat', text: t('performance.delta.none'), favourable: null }
  const up = delta > 0
  return {
    direction: up ? 'up' : 'down',
    text: t(up ? 'performance.delta.clicksUp' : 'performance.delta.clicksDown', {
      value: Math.abs(delta).toLocaleString('en-GB'),
    }),
    favourable: up,
  }
}

export function positionDelta(delta: number, t: Translate = defaultTranslate): Delta {
  const rounded = Math.round(delta * 10) / 10
  if (rounded === 0) {
    return { direction: 'flat', text: t('performance.delta.none'), favourable: null }
  }
  const improved = rounded < 0
  return {
    direction: improved ? 'up' : 'down',
    text: t(improved ? 'performance.delta.positionUp' : 'performance.delta.positionDown', {
      value: Math.abs(rounded),
    }),
    favourable: improved,
  }
}

/** `0.0224` is `2.2%`. Click-through rates are small; one decimal is the honest resolution. */
export function formatCtr(ctr: number): string {
  return `${(ctr * 100).toFixed(1)}%`
}

export function formatCount(value: number): string {
  return value.toLocaleString('en-GB')
}

/** A mean position is a place in a list, and a tenth of a place is as fine as it gets. */
export function formatPosition(value: number): string {
  return (Math.round(value * 10) / 10).toFixed(1)
}

// ── Signal badges ───────────────────────────────────────────────────────────

export interface SignalBadge {
  readonly signalType: string
  readonly opportunityId: string
  readonly href: string
}

/**
 * The badges on a row, and where each one goes.
 *
 * This is the reason the table exists rather than being a report to admire:
 * every badge is a link into a scored opportunity with an action attached. The
 * address matches the one the calendar already uses to point at an opportunity,
 * so the two surfaces link to the same place in the same way.
 */
export function signalBadges(
  row: SearchConsoleRow,
  opportunitiesHref = '/opportunities',
): readonly SignalBadge[] {
  return row.signals.map((signal) => ({
    signalType: signal.signalType,
    opportunityId: signal.opportunityId,
    href: `${opportunitiesHref}#${signal.opportunityId}`,
  }))
}
