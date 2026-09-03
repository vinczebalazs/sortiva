import { describe, expect, it } from 'vitest'
import { stableSlug } from './metadata'

describe('stableSlug', () => {
  it('slugifies the keyword', () => {
    expect(stableSlug('Best Trail Running Shoes', new Set())).toBe('best-trail-running-shoes')
  })

  it('appends a numeric suffix on collision, and keeps looking until free', () => {
    expect(stableSlug('trail shoes', new Set(['trail-shoes']))).toBe('trail-shoes-2')
    expect(stableSlug('trail shoes', new Set(['trail-shoes', 'trail-shoes-2']))).toBe('trail-shoes-3')
  })

  it('never collides with an existing slug', () => {
    const existing = new Set(['trail-shoes'])
    const slug = stableSlug('trail shoes', existing)
    expect(existing.has(slug)).toBe(false)
  })
})
