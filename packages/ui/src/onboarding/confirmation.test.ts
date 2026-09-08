import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RESPONSE_FIXTURES } from '../msw/fixtures'
import { t } from '../strings'
import { ActivationHeader } from './ActivationHeader'
import { ConfirmationReview } from './ConfirmationReview'
import { FindingOpportunities, SCAN_STAGES } from './FindingOpportunities'
import {
  canAddCompetitor,
  isConfirmable,
  MAX_COMPETITORS,
  moveItem,
  type DraftCompetitor,
  type ProfileDraft,
} from './confirmation'

/** React escapes apostrophes and ampersands; these assertions are about words. */
const render = (element: Parameters<typeof renderToStaticMarkup>[0]) =>
  renderToStaticMarkup(element)
    .replaceAll('&#x27;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&amp;', '&')

/**
 * The draft the screen is built against is the mock server's own, so a field
 * this screen reads cannot quietly disappear from the contract.
 */
const PROFILE = RESPONSE_FIXTURES['GET /api/profile'] as unknown as ProfileDraft

const competitors = (count: number): readonly DraftCompetitor[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `competitor-${index}`,
    domain: `rival${index}.example`,
    source: 'auto' as const,
  }))

// ── What may be confirmed ────────────────────────────────────────────────────

describe('the button that ends onboarding', () => {
  const valid = { description: 'An outdoor retailer.', language: 'en', country: 'GB' }

  it('is available once the fields every later step depends on hold something', () => {
    expect(isConfirmable(valid)).toBe(true)
  })

  it('waits for a description, because every later decision is drawn from it', () => {
    expect(isConfirmable({ ...valid, description: '   ' })).toBe(false)
  })

  it('waits for a language and a country, because every search lookup needs both', () => {
    expect(isConfirmable({ ...valid, language: '' })).toBe(false)
    expect(isConfirmable({ ...valid, country: 'GBR' })).toBe(false)
  })
})

describe('the five-competitor cap', () => {
  it('lets a fifth in and stops at a sixth', () => {
    expect(canAddCompetitor(competitors(4))).toBe(true)
    expect(canAddCompetitor(competitors(MAX_COMPETITORS))).toBe(false)
  })

  /**
   * Deliberately not `toBe(5)`, which is what stood here: one copy of the number
   * checked against another copy of the number proves only that somebody typed
   * it twice. The number is enforced in the database and in the repository, and
   * this screen's copy of it is held to those in
   * `apps/web/app/(app)/_lib/competitor-cap.test.ts` — the application is the
   * only package that can see both, because a screen must not import the
   * database layer.
   */
  it('is a number this screen can act on at all', () => {
    expect(MAX_COMPETITORS).toBeGreaterThan(0)
  })
})

describe('reordering the best sellers', () => {
  it('moves a row and leaves the rest in order', () => {
    expect(moveItem(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b'])
  })

  it('leaves the list alone when the move goes nowhere', () => {
    const list = ['a', 'b', 'c']
    expect(moveItem(list, 1, 1)).toBe(list)
    expect(moveItem(list, 0, 9)).toBe(list)
  })
})

// ── The screen ───────────────────────────────────────────────────────────────

describe('the confirmation review', () => {
  const html = render(createElement(ConfirmationReview, { profile: PROFILE }))

  it('renders all seven sections the spec lists, in order', () => {
    const sections = [...html.matchAll(/data-confirm-section="([a-z_]+)"/g)].map((m) => m[1])
    expect(sections).toEqual([
      'business_profile',
      'top_products',
      'keywords',
      'competitors',
      'families',
      'richness',
      'search_console',
      'closing',
    ])
  })

  it('explains the competitor cap in the words the spec gives, as a tooltip and on the page', () => {
    expect(html).toContain('Limited to 5 — competitor analysis is the most expensive thing we run.')
  })

  it('offers the domains seen ranking as suggestions, with how often they appeared', () => {
    expect(html).toContain('suggested.example')
    expect(html).toContain(t('confirm.competitors.addSuggestion'))
    expect(html).toContain('ranks alongside you in 8 top searches')
  })

  it('lists the families as accordions, with their axes and how they were grouped', () => {
    expect(html).toContain('<details')
    expect(html).toContain('Trail Running')
    expect(html).toContain('terrain')
    expect(html).toContain(t('confirm.families.source.fact_clustering'))
    expect(html).toContain(t('confirm.families.report'))
  })

  it('says what the store’s pages actually state, and where the gaps become tasks', () => {
    expect(html).toContain('data-richness-band="okay"')
    expect(html).toContain('These will show up as tasks on your Products page')
  })

  it('says whether Search Console is connected, without making it a blocker', () => {
    expect(html).toContain(t('confirm.gsc.connected'))
    expect(html).toContain(t('confirm.gsc.informational'))
  })

  it('shows a term whose numbers have not arrived as fetching, never as zero', () => {
    const pending = render(
      createElement(ConfirmationReview, {
        profile: {
          ...PROFILE,
          keywords: [
            {
              id: 'k1',
              term: 'winter fell kit',
              monthlySearchVolume: null,
              difficulty: null,
              source: 'manual',
              enrichmentState: 'pending',
            },
          ],
        },
      }),
    )
    expect(pending).toContain('data-enrichment="pending"')
    expect(pending).toContain(t('confirm.keywords.pending'))
  })

  it('switches the add controls off once five competitors are in, rather than letting a refusal happen', () => {
    const full = render(
      createElement(ConfirmationReview, { profile: { ...PROFILE, competitors: competitors(5) } }),
    )
    expect(full).toContain('data-competitors-at-cap="true"')
    expect(full).toMatch(/<button[^>]*disabled[^>]*>Add<\/button>/)
  })
})

// ── The first scan, and landing on what it found ─────────────────────────────

describe('the wait for the first scan', () => {
  const html = render(createElement(FindingOpportunities, {}))

  it('names the work in the order it happens', () => {
    for (const stage of SCAN_STAGES) expect(html).toContain(t(stage.labelKey))
    expect([...html.matchAll(/data-scan-stage="/g)]).toHaveLength(5)
  })

  it('invites the merchant to leave rather than pinning them to a progress bar', () => {
    expect(html).toContain(t('finding.body'))
  })
})

describe('landing on what the first scan found', () => {
  it('carries the headline the product may not reword', () => {
    const html = render(createElement(ActivationHeader, { count: 23 }))
    expect(html).toContain('We found 23 ways to grow your store organically')
  })

  it('explains each of the four actions, once', () => {
    const html = render(createElement(ActivationHeader, { count: 23 }))
    for (const action of ['create', 'optimize', 'refresh', 'fix']) {
      expect(html).toContain(`data-action-type="${action}"`)
    }
    expect(html).toContain(t('activation.create'))
  })

  it('says nothing when the strip has already been dismissed', () => {
    const html = render(createElement(ActivationHeader, { count: 23, explainerDismissed: true }))
    expect(html).not.toContain(t('activation.create'))
    expect(html).toContain('We found 23 ways to grow your store organically')
  })

  it('badges a store with no Search Console, and offers the connection in place of the last card', () => {
    const html = render(createElement(ActivationHeader, { count: 9, limitedIntelligence: true }))
    expect(html).toContain('data-activation-limited="true"')
    expect(html).toContain(t('badge.limitedIntelligence'))
    expect(html).toContain('data-action-type="gsc_nudge"')
    expect(html).not.toContain('data-action-type="fix"')
  })
})

// ── The cap is a ceiling, never a target ─────────────────────────────────────

describe('nothing on these screens renders a count against a denominator', () => {
  const surfaces = [
    render(createElement(ConfirmationReview, { profile: PROFILE })),
    render(createElement(ConfirmationReview, { profile: { ...PROFILE, competitors: competitors(5) } })),
    render(createElement(FindingOpportunities, {})),
    render(createElement(ActivationHeader, { count: 23 })),
  ]

  it('renders no "x of y" and no "x/y"', () => {
    for (const html of surfaces) {
      const text = html.replace(/<[^>]*>/g, ' ')
      expect(text).not.toMatch(/\b\d+\s*(of|\/)\s*\d+\b/)
    }
  })
})
