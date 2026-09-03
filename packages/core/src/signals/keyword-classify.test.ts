import { describe, expect, it } from 'vitest'
import { classifyKeywordIntent, mapKeywordToFamilies } from './keyword-classify'

describe('classifyKeywordIntent — a deterministic stand-in for the family-mapping lineage T2.6 does not persist (see DECISIONS 2026-09-03 T3.7)', () => {
  it('reads comparison phrasing', () => {
    expect(classifyKeywordIntent('trail shoes vs road shoes')).toBe('comparison')
    expect(classifyKeywordIntent('Nike Pegasus versus Hoka Clifton')).toBe('comparison')
  })

  it('reads buying-guide phrasing', () => {
    expect(classifyKeywordIntent('best trail running shoes')).toBe('buying_guide')
    expect(classifyKeywordIntent('trail running shoes buying guide')).toBe('buying_guide')
  })

  it('reads how-to phrasing that is not also buying-guide phrasing', () => {
    expect(classifyKeywordIntent('how to clean trail running shoes')).toBe('how_to')
  })

  it('falls back to informational for plain descriptive terms', () => {
    expect(classifyKeywordIntent('trail running shoes')).toBe('informational')
  })
})

describe('mapKeywordToFamilies — word overlap, never invention', () => {
  const families = [
    { id: 'fam-1', name: 'Trail Running Shoes', differentiationAxes: ['width', 'terrain'] },
    { id: 'fam-2', name: 'Road Running Shoes', differentiationAxes: ['cushioning'] },
  ]

  it('matches a family whose name shares a significant word with the keyword, including a family sharing "running shoes"', () => {
    // "running" and "shoes" are shared by both families' names — a real
    // overlap, not a bug: "trail" alone is what should have disambiguated it,
    // and does, once the axis-word match below is read on its own.
    expect(mapKeywordToFamilies('best trail running shoes', families)).toEqual(['fam-1', 'fam-2'])
  })

  it('matches a family through a differentiation axis word no other family shares — exact word overlap, not stemming', () => {
    expect(mapKeywordToFamilies('width sizing jacket', families)).toEqual(['fam-1'])
  })

  it('can match more than one family, sorted', () => {
    expect(mapKeywordToFamilies('running shoes', families)).toEqual(['fam-1', 'fam-2'])
  })

  it('never invents a match with nothing shared', () => {
    expect(mapKeywordToFamilies('waterproof jackets', families)).toEqual([])
  })
})
