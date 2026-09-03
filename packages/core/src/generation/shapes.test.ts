import { describe, expect, it } from 'vitest'
import { ARTICLE_SHAPES, sectionsFor, selectShape, skeletonFor } from './shapes'

describe('sectionsFor', () => {
  it('expands a buying guide skeleton with one subsection per family axis', () => {
    const sections = sectionsFor('buying_guide', ['terrain', 'width', 'budget'])
    expect(sections).toEqual([
      'The decision',
      'Selection criteria: by terrain',
      'Selection criteria: by width',
      'Selection criteria: by budget',
      'Recommended types',
      'Common mistakes',
      'Products',
    ])
  })

  it('leaves a shape with no axis-derived section untouched by axes', () => {
    expect(sectionsFor('sizing', ['whatever'])).toEqual(skeletonFor('sizing').sections)
  })

  it('falls back to the plain section name when the family has no axes', () => {
    expect(sectionsFor('comparison', [])).toEqual(skeletonFor('comparison').sections)
  })
})

describe('skeletonFor', () => {
  it('names a failure condition for every one of the seven shapes', () => {
    for (const shape of ARTICLE_SHAPES) {
      expect(skeletonFor(shape).failureCondition.length).toBeGreaterThan(0)
    }
  })
})

describe('selectShape', () => {
  it('maps buying_guide and comparison one-to-one', () => {
    expect(selectShape('buying_guide', { head: 'best trail shoes', members: [] })).toBe('buying_guide')
    expect(selectShape('comparison', { head: 'trailblazer vs pathfinder', members: [] })).toBe('comparison')
  })

  it('routes a problem-shaped how_to topic to troubleshooting', () => {
    expect(selectShape('how_to', { head: 'shoe zipper broken', members: [] })).toBe('troubleshooting')
    expect(selectShape('how_to', { head: 'how to clean hiking boots', members: [] })).toBe('how_to')
  })

  it('routes a sizing-shaped informational topic to sizing, otherwise category_explainer', () => {
    expect(selectShape('informational', { head: 'shoe size chart', members: [] })).toBe('sizing')
    expect(selectShape('informational', { head: 'what is a trail running shoe', members: [] })).toBe('category_explainer')
  })
})
