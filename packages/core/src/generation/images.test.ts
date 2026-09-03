import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { emptyFactSheet } from '../distill/schema'
import { catalogImagesFor } from './images'

describe('catalogImagesFor', () => {
  it('passes catalog URLs straight through, unmodified', () => {
    const images = catalogImagesFor([
      {
        productId: 'p1',
        familyId: 'f1',
        title: 'Trailblazer',
        images: [{ url: 'https://cdn.shopify.com/a.jpg' }, { url: 'https://cdn.shopify.com/b.jpg' }],
        factSheet: { ...emptyFactSheet(), material: 'leather' },
      },
    ])
    expect(images).toEqual([
      { url: 'https://cdn.shopify.com/a.jpg', alt: 'Trailblazer — leather', productId: 'p1' },
      { url: 'https://cdn.shopify.com/b.jpg', alt: 'Trailblazer — leather', productId: 'p1' },
    ])
  })

  it('produces nothing for a product with no catalog images', () => {
    expect(
      catalogImagesFor([{ productId: 'p1', familyId: 'f1', title: 'T', images: [], factSheet: emptyFactSheet() }]),
    ).toEqual([])
  })
})

/**
 * Main §9.2: "product images from the catalog only... No AI image generation
 * for now." This card's own done-when: "images are catalog URLs only (no
 * generated/proxied image, grep + test)." A functional test can only prove
 * the function we wrote behaves — it cannot prove nobody added a second path.
 * This scans every source file in this package for a generation/proxy vendor
 * name or call, so a future addition trips a test rather than a review.
 */
// Specific vendor/API names only — a generic phrase like "image generation"
// belongs in this file's own explanatory comments (main §9.2 is quoted
// verbatim above) and would make the grep self-defeating.
const FORBIDDEN_TOKENS = [
  'dall-e',
  'dalle',
  'stability.ai',
  'stability-ai',
  'midjourney',
  'replicate.com',
  'imagen',
  'generateimage',
]

describe('no image generation or proxying anywhere in packages/core/generation', () => {
  const dir = dirname(fileURLToPath(import.meta.url))
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))

  it('found at least one source file to scan', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  for (const file of files) {
    it(`${file} names no image-generation or image-proxy vendor`, () => {
      const text = readFileSync(join(dir, file), 'utf8').toLowerCase()
      for (const token of FORBIDDEN_TOKENS) {
        expect(text.includes(token.toLowerCase())).toBe(false)
      }
    })
  }
})
