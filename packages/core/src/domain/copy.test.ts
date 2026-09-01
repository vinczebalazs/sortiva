import { describe, expect, it } from 'vitest'
import {
  accountHasOtherDomainMessage,
  DOMAIN_ALREADY_CLAIMED_MESSAGE,
  INVALID_DOMAIN_MESSAGE,
} from './copy'

/**
 * The already-claimed error is fixed copy, used word for word, so it is a string
 * and not a paraphrase: the merchant it reaches has to know that contacting
 * support is the way out, and the support team has to recognise the sentence.
 */

describe('domain claim copy (main §5, ui §3.1)', () => {
  it('quotes main §5 verbatim', () => {
    expect(DOMAIN_ALREADY_CLAIMED_MESSAGE).toBe(
      'This domain is already connected to another account. If you believe this is a mistake, contact support.',
    )
  })

  it('names the domain the account already holds, and never blames a stranger', () => {
    const message = accountHasOtherDomainMessage('first.com')
    expect(message).toContain('first.com')
    expect(message).not.toContain('another account')
  })

  it('has no denominators or counts (invariant 23)', () => {
    for (const copy of [
      DOMAIN_ALREADY_CLAIMED_MESSAGE,
      INVALID_DOMAIN_MESSAGE,
      accountHasOtherDomainMessage('first.com'),
    ]) {
      expect(copy).not.toMatch(/\b\d+\s*(of|\/)\s*\d+\b/)
    }
  })
})
