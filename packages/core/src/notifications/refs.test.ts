import { describe, expect, it } from 'vitest'
import { NotificationPayloadError, assertReferenceOnly, isReferenceOnly } from './refs'

describe('notification payloads hold references only', () => {
  it('accepts ids, handles and period tokens', () => {
    expect(() =>
      assertReferenceOnly({
        article_id: '0f8fad5b-d9cb-469f-a165-70867728950e',
        period: '2026-08',
        iso_week: '2026-W35',
        shop_handle: 'example-store',
      }),
    ).not.toThrow()
  })

  it('rejects a headline, which is the failure that matters', () => {
    // The standing risk this guard exists for: product content leaking out of
    // the store and into records that outlive it.
    expect(() =>
      assertReferenceOnly({ title: 'Ten ways to store your winter coat' }),
    ).toThrow(NotificationPayloadError)
  })

  it('rejects a paragraph of article body', () => {
    expect(
      isReferenceOnly({
        excerpt: 'Wool needs air. Store it loose, in a breathable bag, away from direct sun.',
      }),
    ).toBe(false)
  })

  it('rejects a key that is not an identifier', () => {
    expect(() => assertReferenceOnly({ 'Article Title': 'x' })).toThrow(NotificationPayloadError)
  })

  it('rejects a value long enough to be prose without spaces', () => {
    expect(isReferenceOnly({ blob: 'a'.repeat(129) })).toBe(false)
  })

  it('accepts an empty payload — some events reference nothing', () => {
    expect(() => assertReferenceOnly({})).not.toThrow()
  })
})
