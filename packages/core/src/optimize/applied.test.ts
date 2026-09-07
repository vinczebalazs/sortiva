import { describe, expect, it } from 'vitest'
import { detectApplied } from './applied'
import { fixtureRecommendation } from './testing/fixture'

/** Main §10.4: notice, then ask. Nothing here decides anything on its own. */

const recommendation = fixtureRecommendation()

describe('heuristic applied detection', () => {
  it('says nothing about a page that has not changed', () => {
    const detection = detectApplied(recommendation, {
      status: 'live',
      seoTitle: 'Wide trail running shoes | Example Store',
      seoDescription: 'Trail shoes with room across the forefoot.',
      headings: ['Wide trail running shoes', 'Our widths'],
    })

    expect(detection.looksApplied).toBe(false)
    expect(detection.signals).toEqual([])
  })

  it('notices the suggested search-result title now on the page', () => {
    const detection = detectApplied(recommendation, {
      status: 'live',
      seoTitle: '  wide TRAIL running shoes for wide feet | Example Store ',
      seoDescription: 'Trail shoes with room across the forefoot.',
      headings: ['Wide trail running shoes'],
    })

    expect(detection.signals).toEqual(['title_matches_suggestion'])
    expect(detection.looksApplied).toBe(true)
  })

  it('notices a suggested heading that has since appeared', () => {
    const detection = detectApplied(recommendation, {
      status: 'live',
      seoTitle: null,
      seoDescription: null,
      headings: ['Wide trail running shoes', 'How to measure your forefoot'],
    })

    expect(detection.signals).toEqual(['suggested_heading_present'])
    expect(detection.headingsFound).toContain('How to measure your forefoot')
  })

  it('does not read a merchant\'s own rewording as an application', () => {
    const detection = detectApplied(recommendation, {
      status: 'live',
      seoTitle: 'Wide-fit trail shoes for runners | Example Store',
      seoDescription: 'Trail shoes for wide feet, in two widths.',
      headings: ['Measuring your feet'],
    })

    expect(detection.looksApplied).toBe(false)
  })

  /**
   * The exact page state the second test above calls an application — same
   * title, same headings — with only the store no longer serving the address.
   * Written that way on purpose: a deleted row keeps every field compared, so
   * nothing else in this function can tell the two apart, and a test built on
   * a page that had also changed would pass with the check taken out.
   */
  it('asks nothing about a page the store no longer serves', () => {
    const detection = detectApplied(recommendation, {
      status: 'gone',
      seoTitle: '  wide TRAIL running shoes for wide feet | Example Store ',
      seoDescription: 'Trail shoes with room across the forefoot.',
      headings: ['Wide trail running shoes', 'How to measure your forefoot'],
    })

    expect(detection.looksApplied).toBe(false)
    expect(detection.signals).toEqual([])
    expect(detection.headingsFound).toEqual([])
  })

  it('asks again once the page is back in the store', () => {
    const page = {
      seoTitle: '  wide TRAIL running shoes for wide feet | Example Store ',
      seoDescription: 'Trail shoes with room across the forefoot.',
      headings: ['Wide trail running shoes'],
    }

    // Nothing rewrites the row when a deleted page comes back — the walk moves
    // the status and the fields are the ones it always had — so this is the
    // whole of what restoration takes.
    expect(detectApplied(recommendation, { ...page, status: 'gone' }).looksApplied).toBe(false)
    expect(detectApplied(recommendation, { ...page, status: 'live' }).looksApplied).toBe(true)
  })
})
