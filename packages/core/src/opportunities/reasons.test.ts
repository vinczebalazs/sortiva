import { describe, expect, it } from 'vitest'
import { reasonFor } from './reasons'
import type { DetectedSignal } from './action-selection'

/**
 * The sentence a merchant reads for a store competing with itself.
 *
 * Two different things confirm this finding and only one of them is a change:
 * either the page Google leads with keeps moving week to week, or the search
 * simply earns fewer clicks than it did a quarter ago. One sentence covered
 * both and said Google kept changing which page it showed — which, for every
 * merchant whose finding came from the falling clicks alone, had not happened.
 *
 * The detector already recorded which ground carried it. These cases hold that
 * the recorded ground picks the sentence, so the product cannot go back to
 * telling a merchant about a change nobody observed.
 */

const WINDOW = { from: '2026-02-01', to: '2026-02-28' }

function cannibalization(via: 'alternation' | 'aggregate_loss' | 'both'): DetectedSignal {
  return {
    signalType: 'cannibalization',
    clusterHead: 'trail running shoes',
    clusterImpressions: 900,
    clusterClicks: 20,
    competing: [
      { page: '/a', pageType: 'collection', intentClass: 'buying_guide', clicks: 10, impressions: 450, impressionShare: 0.5, position: 7 },
      { page: '/b', pageType: 'collection', intentClass: 'buying_guide', clicks: 10, impressions: 450, impressionShare: 0.5, position: 9 },
      { page: '/c', pageType: 'collection', intentClass: 'buying_guide', clicks: 0, impressions: 100, impressionShare: 0.1, position: 14 },
    ],
    weeklyLeaders: [{ weekStart: '2026-02-01', page: '/a' }],
    leaderChanges: via === 'aggregate_loss' ? 0 : 2,
    baselineClusterClicks: 40,
    clicksVsBaselineRatio: 0.5,
    validation: { validated: true, intentClass: 'buying_guide', via },
    window: WINDOW,
    evidence: [],
  } as unknown as DetectedSignal
}

const keyFor = (signal: DetectedSignal): string => reasonFor(signal, 'fix').reasonTemplateKey

describe('which sentence a store competing with itself is given', () => {
  /**
   * The words themselves live in the copy catalogue and are asserted there —
   * `packages/core` may not import `packages/ui`. What is decided here is which
   * of the three a merchant is shown, which is the half that was wrong.
   */
  it('picks the moving-leader sentence only when the leader moved', () => {
    expect(keyFor(cannibalization('alternation'))).toBe('cannibalization.fix_alternation')
  })

  /** The case the card exists for: the leader never moved and `leader_changes` is nought. */
  it('picks the falling-clicks sentence when that is what confirmed the finding', () => {
    expect(keyFor(cannibalization('aggregate_loss'))).toBe('cannibalization.fix_aggregate_loss')
  })

  it('picks the sentence naming both when both were observed', () => {
    expect(keyFor(cannibalization('both'))).toBe('cannibalization.fix_both')
  })

  it('counts every competing page, not just the two that led', () => {
    expect(reasonFor(cannibalization('both'), 'fix').reasonParams['competing_urls']).toBe(3)
  })

  /**
   * Only findings the detector validated become opportunities. One that failed
   * validation arriving here means it was taken from the wrong half of the
   * detector's answer, and there is no true sentence to give it.
   */
  it('refuses a finding the detector did not confirm, rather than inventing a sentence', () => {
    const unconfirmed = {
      ...cannibalization('both'),
      validation: { validated: false, reason: 'no_alternation_or_loss' },
    } as unknown as DetectedSignal

    expect(() => reasonFor(unconfirmed, 'fix')).toThrow(/did not pass validation/)
  })
})
