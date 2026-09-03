import { describe, expect, it } from 'vitest'
import { detectApplied } from './applied'
import { fixtureRecommendation } from './testing/fixture'

/** Main §10.4: notice, then ask. Nothing here decides anything on its own. */

const recommendation = fixtureRecommendation()

describe('heuristic applied detection', () => {
  it('says nothing about a page that has not changed', () => {
    const detection = detectApplied(recommendation, {
      seoTitle: 'Wide trail running shoes | Example Store',
      seoDescription: 'Trail shoes with room across the forefoot.',
      headings: ['Wide trail running shoes', 'Our widths'],
    })

    expect(detection.looksApplied).toBe(false)
    expect(detection.signals).toEqual([])
  })

  it('notices the suggested search-result title now on the page', () => {
    const detection = detectApplied(recommendation, {
      seoTitle: '  wide TRAIL running shoes for wide feet | Example Store ',
      seoDescription: 'Trail shoes with room across the forefoot.',
      headings: ['Wide trail running shoes'],
    })

    expect(detection.signals).toEqual(['title_matches_suggestion'])
    expect(detection.looksApplied).toBe(true)
  })

  it('notices a suggested heading that has since appeared', () => {
    const detection = detectApplied(recommendation, {
      seoTitle: null,
      seoDescription: null,
      headings: ['Wide trail running shoes', 'How to measure your forefoot'],
    })

    expect(detection.signals).toEqual(['suggested_heading_present'])
    expect(detection.headingsFound).toContain('How to measure your forefoot')
  })

  it('does not read a merchant\'s own rewording as an application', () => {
    const detection = detectApplied(recommendation, {
      seoTitle: 'Wide-fit trail shoes for runners | Example Store',
      seoDescription: 'Trail shoes for wide feet, in two widths.',
      headings: ['Measuring your feet'],
    })

    expect(detection.looksApplied).toBe(false)
  })
})
