import { describe, expect, it } from 'vitest'
import {
  ACCOUNT_DELETION_CONFIRM_WORD,
  ACCOUNT_DELETION_FACTS,
  CANCELLATION_FACTS,
  PLAN_CANCEL_ANYTIME,
  PLAN_CAP_LINE,
  CHECKOUT_CANCELED_NOTE,
  findNumericDenominator,
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

/**
 * The empty-state sentences that say when we will look at the store again.
 *
 * These are quoted copy: the founder chose a relative interval over a named
 * weekday, so an edit to one of them is a product decision and has to break a
 * test rather than pass review as a tidy-up.
 *
 * This block proves the catalogue holds these exact words, and nothing more.
 * That each screen picks the right one of its four — and picks the wordless
 * form when it has no date to count to — is proved where the screen is actually
 * rendered, in `opportunities.test.ts` and `dashboard.test.ts`.
 */
const NEXT_SCAN_COPY: Record<string, string> = {
  'opportunities.empty': 'No open opportunities right now — the next scan runs in {days} days',
  'opportunities.empty.tomorrow': 'No open opportunities right now — the next scan runs tomorrow',
  'opportunities.empty.today': 'No open opportunities right now — the next scan runs today',
  'opportunities.empty.unscheduled': 'No open opportunities right now',
  'dashboard.growth.empty': 'Nothing new to act on right now. The next scan runs in {days} days.',
  'dashboard.growth.empty.tomorrow':
    'Nothing new to act on right now. The next scan runs tomorrow.',
  'dashboard.growth.empty.today': 'Nothing new to act on right now. The next scan runs today.',
  'dashboard.growth.empty.unscheduled': 'Nothing new to act on right now.',
}

const WEEKDAY = /\b(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day\b/

describe('when we look again', () => {
  for (const [key, value] of Object.entries(NEXT_SCAN_COPY)) {
    it(`holds ${key} verbatim`, () => {
      expect(t(key as never)).toBe(value)
    })
  }

  /**
   * A store is scanned on its own local Monday, and a re-queued or paused
   * account moves even that. A screen naming a weekday therefore tells some
   * merchants something untrue every week — and on the Opportunities screen it
   * would sit directly under a header printing the real date.
   */
  it('names no weekday on any screen', () => {
    const offenders = Object.entries(en)
      .filter(([key]) => !key.startsWith('email.'))
      .filter(([, value]) => WEEKDAY.test(value))
      .map(([key]) => key)
    expect(offenders).toEqual([])
  })

  /**
   * The one exemption, pinned so it stays a decision somebody took rather than
   * a string somebody missed. An interval in an email is computed when we send
   * and read whenever the merchant opens it, so "in 3 days" goes stale in an
   * inbox in a way a weekday does not. Whether that sentence should stop naming
   * Monday some other way is a founder question, not a tidy-up.
   */
  it('leaves exactly one weekday, and it is in an email', () => {
    const named = Object.entries(en)
      .filter(([, value]) => WEEKDAY.test(value))
      .map(([key]) => key)
    expect(named).toEqual(['email.monthlySummary.nextNone'])
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

/**
 * The daily cap is a ceiling, never a promise, so no sentence may render a count
 * against a target — "3 of 30" invites a merchant to read the 30 as owed.
 *
 * This used to be one regex written here, and it required a `{placeholder}` on
 * the left. A denominator typed as literal numbers therefore passed it outright:
 * run against five candidate phrasings on 2026-09-08 it caught two. It now calls
 * the same rule the emails are held to, which knows a quantity can be a number
 * or a placeholder and does not care which side is which. The phrasings it has
 * been tried against are below, so the next reader can see what was and was not
 * put to it.
 */
describe('no denominators anywhere in the catalogue', () => {
  /**
   * A scan over a catalogue proves nothing about the catalogue it is not
   * reading. Checked on 2026-09-08 by pruning `en.json` to the 37 keys the
   * other blocks in this file pin by name: every one of the 48 assertions here,
   * this scan included, stayed green while 97% of everything a merchant reads
   * had gone. Nothing said how much was in view, so nothing noticed.
   *
   * Named families rather than a count alone, because a count is what that
   * prune would still have cleared once the catalogue grew: the screens and the
   * email below are where a sentence reporting a count actually lives, and a
   * denominator cannot appear anywhere else.
   */
  it('has the whole catalogue in view (the scan is not vacuously small)', () => {
    const entries = Object.entries(en)
    expect(entries.length).toBeGreaterThan(900)

    const keys = entries.map(([key]) => key)
    for (const family of [
      'performance.',
      'dashboard.',
      'content.',
      'opportunities.',
      'email.monthlySummary.',
    ]) {
      expect(keys.some((key) => key.startsWith(family)), family).toBe(true)
    }

    // And that the sentences in view carry quantities at all: a rule about how
    // two numbers may be joined says nothing over copy containing no numbers.
    const withQuantity = entries.filter(([, value]) => /\d|\{\w+\}/.test(value))
    expect(withQuantity.length).toBeGreaterThan(100)
  })

  it('contains no count stated against a total', () => {
    const offenders = Object.entries(en)
      .map(([key, value]) => [key, findNumericDenominator(value)] as const)
      .filter(([, found]) => found !== undefined)
      .map(([key, found]) => `${key}: ${found!.message}`)
    expect(offenders).toEqual([])
  })
})

describe('the phrasings the catalogue check has been tried against', () => {
  /**
   * The five the sweep used. Three of them passed the old pattern, which is why
   * this check changed; all five are here so a later reader can see the pair it
   * did catch was never the problem.
   */
  const SWEEP = [
    '3 of 30 articles',
    '{count} of {cap}',
    '22/30 published',
    'You have used 12 of your 30',
    '{count} of 30',
  ]

  /**
   * Phrasings the sweep did not think of, added because a check whose only
   * evidence is the cases its author had in mind is the fault being fixed here.
   * Each is a way of writing the same promise: an "out of" spelled in words, a
   * possessive between the halves, and a fraction slash that is not the ASCII
   * one — the character a word processor substitutes without being asked.
   */
  const NOT_IN_THE_SWEEP = [
    '3 out of 30 articles',
    '12 of your 30 this month',
    '22 ⁄ 30 published',
    '{count} of your {cap} articles',
  ]

  for (const phrase of [...SWEEP, ...NOT_IN_THE_SWEEP]) {
    it(`refuses ${JSON.stringify(phrase)}`, () => {
      expect(findNumericDenominator(phrase)).toBeDefined()
    })
  }

  /**
   * The other half of the rule: it has to leave ordinary sentences alone, or the
   * next person to hit it will weaken it rather than reword. "One of your
   * articles" states no total, and the cap line itself is canonical copy.
   */
  for (const phrase of [
    'One of your articles needs a small fix.',
    'Up to 1 article per day, quality permitting',
    'We found {count} ways to grow your store organically',
    'Open your dashboard: https://sortiva.app/settings/notifications',
  ]) {
    it(`allows ${JSON.stringify(phrase)}`, () => {
      expect(findNumericDenominator(phrase)).toBeUndefined()
    })
  }

  /**
   * What it cannot do, stated rather than implied.
   *
   * The rule reads one catalogue value at a time, and it only recognises a
   * quantity written as digits or as a placeholder. A denominator spelled in
   * words passes, and so does one assembled at render time out of two strings
   * that are innocent apart — "{count} published" beside a heading that says
   * "30 this month" is a denominator on the screen and not in any single value
   * here. That second gap is a rendered-output check on the screens that have
   * none, which is somebody else's card; this test cannot close it.
   */
  it('does not catch a denominator spelled in words, or one assembled at render time', () => {
    expect(findNumericDenominator('3 of thirty articles')).toBeUndefined()
    expect(findNumericDenominator('{count} published')).toBeUndefined()
    expect(findNumericDenominator('30 this month')).toBeUndefined()
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
