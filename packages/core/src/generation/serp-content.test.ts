import { describe, expect, it } from 'vitest'
import { buildCompetitorAngle, excerptOf, wordCountOf } from './serp-content'

describe('buildCompetitorAngle', () => {
  it('extracts headings, a stripped-text excerpt, and a word count from raw markup', () => {
    const { angle, wordCount } = buildCompetitorAngle({
      url: 'https://rival.example/guide',
      domain: 'rival.example',
      position: 2,
      bodyHtml: '<h1>Trail shoe buying guide</h1><p>Look for a grippy outsole and a snug heel.</p>',
    })
    expect(angle.headings).toEqual(['Trail shoe buying guide'])
    expect(angle.excerpt).toContain('grippy outsole')
    expect(wordCount).toBeGreaterThan(0)
  })
})

describe('wordCountOf', () => {
  it('counts words, ignoring collapsed whitespace', () => {
    expect(wordCountOf('one  two\nthree')).toBe(3)
    expect(wordCountOf('   ')).toBe(0)
  })
})

describe('excerptOf', () => {
  it('truncates long text with an ellipsis, and leaves short text untouched', () => {
    expect(excerptOf('short')).toBe('short')
    const long = 'a'.repeat(2000)
    expect(excerptOf(long, 100)).toBe(`${'a'.repeat(100)}…`)
  })
})
