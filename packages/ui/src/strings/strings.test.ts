import { describe, expect, it } from 'vitest'
import {
  ACCOUNT_DELETION_CONFIRM_WORD,
  ACCOUNT_DELETION_FACTS,
  CANCELLATION_FACTS,
  PLAN_CANCEL_ANYTIME,
  PLAN_CAP_LINE,
  CHECKOUT_CANCELED_NOTE,
} from '@sortiva/core'
import en from '../../strings/en.json'
import { createTranslate, resolveLanguage, t } from './index'

/**
 * The sentences the product may not reword, quoted from the main spec's
 * canonical-copy table. Any edit to one of these is a product decision, so it
 * has to break a test rather than pass review as a typo fix.
 */
const CANONICAL: Record<string, string> = {
  'appendixA.landingPreviewTeaser': 'See your organic growth opportunities →',
  'appendixA.pricingCap': 'Up to 1 article per day, quality permitting',
  'appendixA.gscConnect': 'Connect Google Search Console to unlock full Growth Intelligence',
  'appendixA.limitedModeBadge':
    'Limited Intelligence — connect Search Console to see real query and page opportunities',
  'appendixA.opportunityHeadline': 'We found {count} ways to grow your store organically',
  'appendixA.existingPageWhyLine':
    'You already rank for this. Improving the existing collection is safer than creating another page.',
  'appendixA.qualityRejectionRichness':
    'We held this topic back because the store does not contain enough factual product information yet.',
  'appendixA.outage':
    'Delayed — we paused this action rather than continue with lower-quality or stale data.',
  'appendixA.shopifyReadOnlyTrust':
    "Read-only — we can't change anything in your store with this permission. Auto-publishing is a separate optional setting you control later.",
  'appendixA.notShopifyParked':
    "This doesn't look like a Shopify store. We currently support Shopify only — contact us for a custom solution or join the waitlist.",
  'appendixA.cancellationFact.articlesStay': 'Your published articles stay on your store.',
  'appendixA.cancellationFact.generationStops':
    'Generation stops at the end of your billing period.',
  'appendixA.cancellationFact.readAccessKept': 'You keep read access to everything.',
}

describe('canonical copy', () => {
  for (const [key, value] of Object.entries(CANONICAL)) {
    it(`renders ${key} verbatim`, () => {
      expect(t(key as never)).toBe(value)
    })
  }

  it('holds every canonical key the catalogue claims', () => {
    const claimed = Object.keys(en).filter((key) => key.startsWith('appendixA.'))
    expect(claimed.sort()).toEqual(Object.keys(CANONICAL).sort())
  })
})

describe('the copy an earlier card had to park in packages/core', () => {
  /**
   * Billing shipped before this package existed, so its canonical strings live
   * in a core module with their own snapshot. Two homes for one sentence is how
   * they drift apart; these assertions make a divergence a red test until the
   * core copy is deleted and billing reads from here.
   */
  it('agrees with the parked billing copy', () => {
    expect(t('appendixA.pricingCap')).toBe(PLAN_CAP_LINE)
    expect(t('billing.cancelAnytime')).toBe(PLAN_CANCEL_ANYTIME)
    expect(t('billing.checkoutCanceled')).toBe(CHECKOUT_CANCELED_NOTE)
    expect([
      t('appendixA.cancellationFact.articlesStay'),
      t('appendixA.cancellationFact.generationStops'),
      t('appendixA.cancellationFact.readAccessKept'),
    ]).toEqual([...CANCELLATION_FACTS])
  })

  /**
   * The delete-account screen's five sentences. Each is a promise the deletion
   * code then has to keep, so they live beside that code as well as here and
   * the two are pinned together — a copy edit that quietly weakened one of them
   * would otherwise be invisible.
   */
  it('agrees with the deletion facts the code keeps', () => {
    expect([
      t('settings.deleteAccount.fact.noFurtherCharges'),
      t('settings.deleteAccount.fact.articlesStay'),
      t('settings.deleteAccount.fact.grantsReturned'),
      t('settings.deleteAccount.fact.domainReserved'),
      t('settings.deleteAccount.fact.dataErased'),
    ]).toEqual([...ACCOUNT_DELETION_FACTS])
    expect(t('settings.deleteAccount.confirmWord')).toBe(ACCOUNT_DELETION_CONFIRM_WORD)
  })
})

describe('no denominators anywhere in the catalogue', () => {
  /**
   * The daily cap is a ceiling, never a promise, so no sentence may render a
   * count against a target — "3 of 30" invites a merchant to read the 30 as
   * owed.
   */
  it('contains no "x of y" or "x/y" phrasing', () => {
    const offenders = Object.entries(en).filter(([, value]) =>
      /\{\w+\}\s*(of|\/)\s*\{?\w+\}?/i.test(value),
    )
    expect(offenders).toEqual([])
  })
})

describe('interpolation', () => {
  it('fills named placeholders', () => {
    expect(t('appendixA.opportunityHeadline', { count: 23 })).toBe(
      'We found 23 ways to grow your store organically',
    )
  })

  it('leaves a placeholder alone when nothing was supplied for it', () => {
    expect(t('appendixA.opportunityHeadline')).toContain('{count}')
  })

  it('throws on an unknown key rather than rendering it', () => {
    expect(() => t('nav.nope' as never)).toThrow(/packages\/ui\/strings\/en\.json/)
  })
})

describe('language resolution', () => {
  it('prefers the merchant\'s saved choice', () => {
    expect(resolveLanguage({ saved: 'en', browser: ['de-DE'] })).toBe('en')
  })

  it('falls back to the browser language when nothing is saved', () => {
    expect(resolveLanguage({ saved: null, browser: ['en-GB', 'fr'] })).toBe('en')
  })

  it('falls back to English for a language we do not ship', () => {
    expect(resolveLanguage({ saved: 'hu', browser: ['hu-HU'] })).toBe('en')
  })

  it('serves English strings for an unknown language rather than failing', () => {
    expect(createTranslate('de' as never)('nav.dashboard')).toBe('Dashboard')
  })
})
