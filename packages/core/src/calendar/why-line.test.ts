import { describe, expect, it } from 'vitest'
import {
  REPLENISHMENT_WHY_COMPETITOR,
  REPLENISHMENT_WHY_EXPLORATION,
  REPLENISHMENT_WHY_REFRESH_POSITION,
  REPLENISHMENT_WHY_WINNING_PATTERN,
} from './replenishment'
import { topicWhyLine, type TopicWhyOpportunity } from './why-line'

const fact = (key: string, value: string | number) => ({
  key,
  value,
  source: 'gsc',
  fetchedAt: '2026-09-01T00:00:00.000Z',
})

const opportunity = (over: Partial<TopicWhyOpportunity> = {}): TopicWhyOpportunity => ({
  reasonTemplateKey: 'uncovered_commercial_query.create',
  reasonParams: { volume: 1900 },
  evidence: [],
  ...over,
})

describe('the sentence under a calendar day', () => {
  it('carries the numbers the opportunity measured, which is what a chip was missing', () => {
    expect(
      topicWhyLine({
        whyLineKey: 'uncovered_commercial_query.create',
        fallbackKey: 'topic.auto',
        opportunity: opportunity(),
      }),
    ).toEqual({ templateKey: 'uncovered_commercial_query.create', params: { volume: 1900 } })
  })

  it('hands a hand-added topic Gate 1’s own measurements, which the opportunity row holds', () => {
    // A topic the merchant typed in gets an opportunity row of its own, and
    // Gate 1's verdict is written onto it as the reason — key and values in one
    // place. So the chip explaining that verdict has values available today,
    // whatever the sentences currently choose to print.
    expect(
      topicWhyLine({
        whyLineKey: 'gate1.rejected_zero_volume',
        fallbackKey: 'topic.manual_addition',
        opportunity: opportunity({
          reasonTemplateKey: 'gate1.rejected_zero_volume',
          reasonParams: { keyword: 'wide fit trail shoes', monthly_search_volume: 10 },
        }),
      }).params,
    ).toEqual({ keyword: 'wide fit trail shoes', monthly_search_volume: 10 })
  })

  it('says nothing it cannot fill for the two lines the calendar writes itself', () => {
    for (const key of ['topic.auto', 'topic.manual_addition', REPLENISHMENT_WHY_EXPLORATION, REPLENISHMENT_WHY_COMPETITOR]) {
      expect(topicWhyLine({ whyLineKey: key, fallbackKey: 'topic.auto', opportunity: opportunity() })).toEqual({
        templateKey: key,
        params: {},
      })
    }
  })

  it('puts back the ranking position a replenishment day was chosen for', () => {
    expect(
      topicWhyLine({
        whyLineKey: REPLENISHMENT_WHY_REFRESH_POSITION,
        fallbackKey: 'topic.auto',
        opportunity: opportunity({ evidence: [fact('mean_position', 14.2)] }),
      }),
    ).toEqual({ templateKey: REPLENISHMENT_WHY_REFRESH_POSITION, params: { position: 14.2 } })
  })

  it('reads the position under either name the detectors record it as', () => {
    expect(
      topicWhyLine({
        whyLineKey: REPLENISHMENT_WHY_REFRESH_POSITION,
        fallbackKey: 'topic.auto',
        opportunity: opportunity({ evidence: [fact('our_position', '8')] }),
      }).params,
    ).toEqual({ position: 8 })
  })

  it('bites: a sentence whose values were never written down is replaced, not left with a blank', () => {
    // The pattern-matching line names the axis a day resembles the store's
    // winners on, and that axis was worked out against a table of patterns that
    // has since moved on. Nothing persists it. Printing the key would show a
    // merchant "going by {dimension}".
    const line = topicWhyLine({
      whyLineKey: REPLENISHMENT_WHY_WINNING_PATTERN,
      fallbackKey: 'topic.auto',
      opportunity: opportunity(),
    })
    expect(line.templateKey).not.toBe(REPLENISHMENT_WHY_WINNING_PATTERN)
    expect(line).toEqual({ templateKey: 'uncovered_commercial_query.create', params: { volume: 1900 } })
  })

  it('bites: a position line with no position recorded is replaced too', () => {
    const line = topicWhyLine({
      whyLineKey: REPLENISHMENT_WHY_REFRESH_POSITION,
      fallbackKey: 'topic.auto',
      opportunity: opportunity({ evidence: [fact('impressions', 400)] }),
    })
    expect(line).toEqual({ templateKey: 'uncovered_commercial_query.create', params: { volume: 1900 } })
  })

  it('bites: a key that has drifted from the opportunity’s current reason takes the current one whole', () => {
    // Re-detection updates an opportunity in place rather than making a second
    // one, so the reason on the row can change under a day that was planned
    // from it. The key and its values are stored together, so taking both is
    // the only way the sentence stays fillable.
    const line = topicWhyLine({
      whyLineKey: 'striking_distance.optimize',
      fallbackKey: 'topic.auto',
      opportunity: opportunity({
        reasonTemplateKey: 'content_decay.refresh',
        reasonParams: { from_position: 4, to_position: 19, clicks_before: 300, clicks_after: 40 },
      }),
    })
    expect(line.templateKey).toBe('content_decay.refresh')
    expect(line.params).toEqual({ from_position: 4, to_position: 19, clicks_before: 300, clicks_after: 40 })
  })

  it('falls back to the screen’s own line when there is no opportunity to read', () => {
    expect(
      topicWhyLine({
        whyLineKey: REPLENISHMENT_WHY_WINNING_PATTERN,
        fallbackKey: 'topic.manual_addition',
        opportunity: null,
      }),
    ).toEqual({ templateKey: 'topic.manual_addition', params: {} })
  })

  it('drops a recorded value that is not a word or a number', () => {
    // `reason_params_json` is free-form. An object interpolated into a
    // merchant's sentence reads as "[object Object]".
    expect(
      topicWhyLine({
        whyLineKey: 'uncovered_commercial_query.create',
        fallbackKey: 'topic.auto',
        opportunity: opportunity({
          reasonParams: { volume: 1900, sources: ['gsc', 'dataforseo'] },
        }),
      }).params,
    ).toEqual({ volume: 1900 })
  })

  it('falls back to the screen’s own line for a day that recorded no reason at all', () => {
    expect(topicWhyLine({ whyLineKey: null, fallbackKey: 'topic.auto', opportunity: opportunity() })).toEqual({
      templateKey: 'topic.auto',
      params: {},
    })
  })
})
