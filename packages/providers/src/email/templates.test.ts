import { describe, expect, it } from 'vitest'
import {
  assertNoDenominator,
  assertNoNumericDenominator,
  canonicalKeysFor,
  copyKeysIn,
  monthlySummaryContent,
  noticeContent,
  NOTICE_TYPES,
  needsUnsubscribe,
  type MonthlySummaryFacts,
} from '@sortiva/core'
import { copyLookup, ReactEmailRenderer } from './render'

/**
 * The email templates, rendered for real.
 *
 * Two of these tests are the card's own conditions rather than ordinary
 * coverage: the monthly summary must contain no denominator, and the emails
 * that restate a canonical sentence must restate it character for character.
 */

const renderer = new ReactEmailRenderer()
const look = copyLookup()

const LINKS = {
  dashboardUrl: 'https://sortiva.app/dashboard',
  unsubscribeUrl: 'https://sortiva.app/api/notifications/unsubscribe?token=tok',
}

const FACTS: MonthlySummaryFacts = {
  period: '2026-08',
  periodLabel: 'August 2026',
  articlesPublished: 22,
  heldBack: [
    { title: 'Choosing a wool blanket', reasonKey: 'appendixA.qualityRejectionRichness' },
    { title: 'Merino care, step by step', reasonKey: 'appendixA.qualityRejectionRichness' },
  ],
  optimizeRecommendationsGenerated: 4,
  optimizeRecommendationsApplied: 2,
  repairsCompleted: 1,
  merchantTasksResolved: 3,
  nextOpportunities: [
    { action: 'optimize', subject: 'the merino blankets collection' },
    { action: 'create', subject: 'washing a wool blanket' },
    { action: 'hold', subject: 'the alpaca throw' },
  ],
  openOpportunityCount: 11,
}

describe('the monthly summary', () => {
  it('states no count against a total — no slash, no "of", no target wording', async () => {
    const content = monthlySummaryContent(FACTS, LINKS)
    // The copy first, gaps unfilled: this is the rule that actually binds,
    // because it judges what we wrote rather than what a merchant called a topic.
    for (const key of copyKeysIn(content)) {
      expect(() => assertNoDenominator(look(key)), key).not.toThrow()
    }
    // Then the finished email, with fixture values chosen to be clean.
    const { text } = await renderer.render(content)
    expect(() => assertNoDenominator(text)).not.toThrow()
  })

  it('reads as a report of what happened', async () => {
    const { subject, text } = await renderer.render(monthlySummaryContent(FACTS, LINKS))
    expect(subject).toBe('Your Sortiva month: August 2026')
    expect(text).toContain('22 articles went live on your store.')
    expect(text).toContain('Choosing a wool blanket')
    expect(text).toContain('Improve the page you already have for the merino blankets collection.')
  })

  it('says a quiet month happened, rather than scoring it', async () => {
    const quiet: MonthlySummaryFacts = {
      ...FACTS,
      articlesPublished: 0,
      heldBack: [],
      optimizeRecommendationsGenerated: 0,
      optimizeRecommendationsApplied: 0,
      repairsCompleted: 0,
      merchantTasksResolved: 0,
      nextOpportunities: [],
    }
    const { text } = await renderer.render(monthlySummaryContent(quiet, LINKS))
    expect(text).toContain('Nothing went live this month.')
    expect(text).not.toMatch(/\b0\b/)
    expect(() => assertNoDenominator(text)).not.toThrow()
  })

  it('carries a one-click unsubscribe, because it is not transactional mail', async () => {
    const { html } = await renderer.render(monthlySummaryContent(FACTS, LINKS))
    expect(html).toContain(LINKS.unsubscribeUrl)
  })

  it('produces a plain-text alternative from the same markup', async () => {
    const { html, text } = await renderer.render(monthlySummaryContent(FACTS, LINKS))
    expect(html).toContain('<!DOCTYPE')
    expect(text).not.toContain('<')
    expect(text).toContain('August 2026 on your store')
  })
})

describe('the notice emails', () => {
  const links = { actionUrl: 'https://sortiva.app/dashboard', unsubscribeUrl: LINKS.unsubscribeUrl }

  it('every kind that gets an email renders with no missing copy', async () => {
    for (const type of NOTICE_TYPES) {
      const content = noticeContent(type, { title: 'A wool blanket guide', count: 7 }, links)
      const { subject, html, text } = await renderer.render(content)
      expect(subject.length, type).toBeGreaterThan(0)
      expect(html, type).toContain('sortiva.app/dashboard')
      expect(() => assertNoNumericDenominator(text), type).not.toThrow()
    }
  })

  it('refuses to assemble one for a kind the monthly summary carries', () => {
    expect(() => noticeContent('topic_held_by_gate', {}, links)).toThrow(/no email of its own/)
  })

  it('restates the read-only promise verbatim in the connect reminder', async () => {
    expect(canonicalKeysFor('oauth_reminder')).toEqual(['appendixA.shopifyReadOnlyTrust'])
    const { text } = await renderer.render(noticeContent('oauth_reminder', {}, links))
    expect(text).toContain(look('appendixA.shopifyReadOnlyTrust'))
  })

  it('restates the activation headline verbatim, with the number filled in', async () => {
    const { text } = await renderer.render(noticeContent('opportunities_ready', { count: 7 }, links))
    expect(text).toContain('We found 7 ways to grow your store organically')
  })

  it('drops the headline rather than printing a gap when the count is gone', async () => {
    const { text } = await renderer.render(noticeContent('opportunities_ready', {}, links))
    expect(text).not.toContain('{N}')
    expect(text).not.toContain('ways to grow')
  })

  it('loses the name and keeps the verb when the article is gone', async () => {
    const named = await renderer.render(
      noticeContent('draft_ready_for_review', { title: 'A wool blanket guide' }, links),
    )
    expect(named.subject).toBe('Ready for your review: A wool blanket guide')

    const gone = await renderer.render(noticeContent('draft_ready_for_review', {}, links))
    expect(gone.subject).toBe('A draft is ready for your review')
    expect(gone.text).toContain('Nothing publishes until you approve it.')
  })

  it('offers an unsubscribe only where the merchant is allowed one', async () => {
    const published = await renderer.render(noticeContent('article_published', { title: 'X' }, links))
    expect(published.html).toContain(LINKS.unsubscribeUrl)
    expect(needsUnsubscribe('connection_lost_shopify')).toBe(false)

    const lost = await renderer.render(noticeContent('connection_lost_shopify', {}, links))
    expect(lost.html).not.toContain(LINKS.unsubscribeUrl)
  })
})
