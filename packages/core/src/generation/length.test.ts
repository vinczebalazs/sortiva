import { describe, expect, it } from 'vitest'
import { lengthTargetFor } from './length'

const CONFIG = { serp_word_count_multiple_min: 0.7, serp_word_count_multiple_max: 1.3, fallback_word_count_min: 600 }

describe('lengthTargetFor', () => {
  it('targets a band around the SERP average, not a fixed count', () => {
    const target = lengthTargetFor(
      { keyword: 'k', locale: 'en-US', topResultCount: 3, averageWordCount: 1000, competitorAngles: [] },
      CONFIG,
    )
    expect(target.source).toBe('serp')
    expect(target.minWords).toBe(700)
    expect(target.maxWords).toBe(1300)
  })

  it('falls back to a plain floor when no SERP page was readable', () => {
    const target = lengthTargetFor(
      { keyword: 'k', locale: 'en-US', topResultCount: 3, averageWordCount: null, competitorAngles: [] },
      CONFIG,
    )
    expect(target.source).toBe('fallback')
    expect(target.minWords).toBe(600)
  })
})
