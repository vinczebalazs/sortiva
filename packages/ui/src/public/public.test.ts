import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { t } from '../strings'
import { LandingPricing } from './Landing'
import { PreviewCard, signupHrefFor } from './PreviewCard'
import { SignIn, SignInLinkSent } from './SignIn'
import { RATE_LIMITED_STATUS, isSubmittable, previewStateFrom, type PreviewState } from './preview-state'

/**
 * The three surfaces a visitor can reach without an account.
 *
 * Two sentences are asserted character for character rather than by key,
 * because they are the two the product may not reword: the teaser that decides
 * how the product is positioned, and the cap line that is a quality promise
 * rather than a count. Both are held to the spec's own canonical-copy table.
 */

const render = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element)

// ── The teaser, verbatim ─────────────────────────────────────────────────────

describe('the landing teaser', () => {
  it('is the canonical sentence, character for character', () => {
    expect(t('appendixA.landingPreviewTeaser')).toMatchInlineSnapshot(
      `"See your organic growth opportunities →"`,
    )
  })

  it('never calls the product a content plan', () => {
    expect(t('appendixA.landingPreviewTeaser').toLowerCase()).not.toContain('content plan')
  })

  it('is on the card whether or not we could read the site', () => {
    const read: PreviewState = { kind: 'result', domain: 'terrafirma.co.uk', summary: 'A shop.' }
    const unread: PreviewState = { kind: 'generic', domain: 'terrafirma.co.uk' }

    for (const state of [read, unread]) {
      const html = render(createElement(PreviewCard, { state }))
      expect(html).toContain(t('appendixA.landingPreviewTeaser'))
    }
  })
})

// ── The cap line, verbatim ───────────────────────────────────────────────────

describe('the plan cap line', () => {
  it('is the canonical sentence, character for character', () => {
    expect(t('appendixA.pricingCap')).toMatchInlineSnapshot(
      `"Up to 1 article per day, quality permitting"`,
    )
  })

  it('renders on the pricing block, from the catalogue rather than restated', () => {
    const html = render(createElement(LandingPricing, { action: null }))
    expect(html).toContain('Up to 1 article per day, quality permitting')
  })

  it('promises no number of articles anywhere on the pricing block', () => {
    const html = render(createElement(LandingPricing, { action: null }))
    // Invariant 23: the cap is a ceiling, never "x of y" or "x/30".
    expect(text(html)).not.toMatch(/\b\d+\s*(?:of|\/)\s*\d+\b/)
  })

  /**
   * The promise is about what the product does, not about what it costs, so it
   * has to outlive the purchase layer that used to carry it. When the plan
   * screen went, this sentence could have gone with it and nothing would have
   * failed.
   */
  it('is on a screen a visitor can actually reach, not only in a constant', () => {
    const html = render(createElement(LandingPricing, { action: null }))
    expect(html).toContain(t('appendixA.pricingCap'))
  })
})

// ── The preview, and its refusal to dead-end ─────────────────────────────────

describe('what the visitor sees after pasting an address', () => {
  it('shows the summary and the address we read', () => {
    const html = render(
      createElement(PreviewCard, {
        state: { kind: 'result', domain: 'terrafirma.co.uk', summary: 'Trail running shoes.' },
      }),
    )
    expect(html).toContain('Trail running shoes.')
    expect(html).toContain('Here&#x27;s what we understood about terrafirma.co.uk')
  })

  it('says it is reading, without a number that could be wrong', () => {
    const html = render(createElement(PreviewCard, { state: { kind: 'loading', typed: 'x.com' } }))
    expect(html).toContain(t('preview.loading'))
  })

  it('answers a site it could not read with an invitation, not an error', () => {
    const html = render(createElement(PreviewCard, { state: { kind: 'generic', domain: 'x.com' } }))
    expect(text(html)).toContain(t('preview.generic'))
    expect(html).toContain(t('appendixA.landingPreviewTeaser'))
    expect(text(html).toLowerCase()).not.toContain('error')
  })

  it('tells a rate-limited visitor to wait, and shows no bot check to redo', () => {
    const html = render(createElement(PreviewCard, { state: { kind: 'rate_limited' } }))
    expect(html).toContain('Too many requests — try again in a minute.')
    expect(html).not.toContain('sortiva-turnstile')
  })

  it('shows nothing at all before anything is typed', () => {
    expect(render(createElement(PreviewCard, { state: { kind: 'idle' } }))).toBe('')
  })
})

describe('turning the endpoint’s answer into a state', () => {
  const body = { domain: 'x.com', summary: 'A shop.', cacheHit: false, generic: false }

  it('reads a summary as a result', () => {
    expect(previewStateFrom({ kind: 'answered', status: 200, body }, 'x.com')).toEqual({
      kind: 'result',
      domain: 'x.com',
      summary: 'A shop.',
    })
  })

  it('reads 429 as the one message that is not the fallback card', () => {
    expect(
      previewStateFrom({ kind: 'answered', status: RATE_LIMITED_STATUS, body: {} }, 'x.com'),
    ).toEqual({ kind: 'rate_limited' })
  })

  it.each([
    ['a generic answer', { kind: 'answered' as const, status: 200, body: { ...body, generic: true, summary: null } }],
    ['a server failure', { kind: 'answered' as const, status: 500, body: {} }],
    ['a body that is not ours', { kind: 'answered' as const, status: 200, body: { nope: 1 } }],
    ['no answer at all', { kind: 'unreachable' as const }],
  ])('lands %s on the same fallback card', (_label, outcome) => {
    expect(previewStateFrom(outcome, 'x.com').kind).toBe('generic')
  })

  it('sends nothing when nothing was typed', () => {
    expect(isSubmittable('   ')).toBe(false)
    expect(isSubmittable('yourstore.com')).toBe(true)
  })
})

// ── The address the visitor typed, carried but never claimed ─────────────────

describe('the address travels as a suggestion', () => {
  it('rides along on the teaser link', () => {
    expect(signupHrefFor({ kind: 'result', domain: 'terra firma.co.uk', summary: 's' })).toBe(
      '/signin?domain=terra%20firma.co.uk',
    )
  })

  it('is left off when there is nothing to carry', () => {
    expect(signupHrefFor({ kind: 'idle' })).toBe('/signin')
  })

  it('is offered back in words that say nothing is claimed yet', () => {
    const html = render(createElement(SignIn, { previewedDomain: 'terrafirma.co.uk' }))
    expect(html).toContain('terrafirma.co.uk')
    expect(text(html)).toContain('nothing is claimed until you confirm it')
  })

  it('is absent from the screen when there was no preview to carry', () => {
    expect(render(createElement(SignIn, {}))).not.toContain('previewed-domain')
  })

  it('does not submit a bare form, which is what stopped anybody signing in', () => {
    // The screen used to post a form carrying only where to land afterwards.
    // The sign-in library refuses a post with no anti-forgery token, so the
    // press went nowhere. The token has to be fetched first, which a form
    // submission cannot do.
    const html = render(createElement(SignIn, {}))
    expect(html).not.toContain('<form')
    expect(html).not.toContain('/api/auth/signin/google')
  })

  it('says nothing about a failure until there has been one', () => {
    expect(render(createElement(SignIn, {}))).not.toContain('signin-failed')
  })
})

// ── Two ways in, one of which needs nothing but a mailbox ───────────────────

/**
 * **The half of email sign-in that no configuration test can see.**
 *
 * The server has offered a sign-in link for as long as `authWiring.test.ts` has
 * asserted it, and `emailSignIn.test.ts` drives the exchange the button runs
 * against the real handlers. Both of those stayed green through the whole
 * period when the screen had a single Google button and a merchant without a
 * Google account could not get in at all — because neither renders the screen.
 * These do. Deleting the field or the button from the component turns this red
 * and nothing else in the repository.
 */
describe('the sign-in screen offers both ways in', () => {
  it('has a Google button and an address to send a link to', () => {
    const html = render(createElement(SignIn, {}))

    expect(html).toContain(t('signin.google'))
    expect(html).toContain(t('signin.email'))
    expect(html).toContain('data-testid="signin-email"')
  })

  it('labels the address field and asks for the keyboard that has an @ on it', () => {
    const html = render(createElement(SignIn, {}))

    expect(html).toContain(t('signin.emailLabel'))
    expect(html).toContain('type="email"')
  })

  it('posts the address through the same exchange as Google, not to the library', () => {
    // A form post carries no anti-forgery token, so it lands on the library's
    // error page — the defect the Google button was already repaired for.
    const html = render(createElement(SignIn, {}))

    expect(html).not.toContain('<form')
    expect(html).not.toContain('/api/auth/signin/email')
  })

  it('tells nobody to go and look in a mailbox until a link has been asked for', () => {
    const html = render(createElement(SignIn, {}))

    expect(html).not.toContain('signin-link-sent')
    expect(html).not.toContain('signin-link-failed')
  })
})

/**
 * **The mistake this screen cannot warn anybody about.**
 *
 * A link sent to a plausible but wrong address produces no error anywhere: it
 * goes to whatever mailbox was named, and the person waiting sees a calm
 * confirmation for a message that will never arrive. Until now the confirmation
 * replaced the address field, so their only way back was reloading the page.
 */
describe('after the link has been sent', () => {
  const html = render(
    createElement(SignInLinkSent, { email: 'ada@yourstore.com', onUseDifferentAddress: () => {} }),
  )

  it('names the address the link actually went to, so a typo is visible', () => {
    expect(html).toContain('ada@yourstore.com')
    expect(html).toContain('data-testid="signin-link-sent"')
  })

  it('offers a way back to the address field', () => {
    expect(html).toContain('data-testid="signin-email-again"')
    expect(html).toContain(t('signin.emailUseDifferent'))
  })

  /**
   * The panel cannot be rendered without one: the way out is a required prop
   * rather than an optional handler, so a caller that forgot it is a compile
   * error rather than a dead end somebody has to find by using the product.
   */
  it('cannot be shown without one', () => {
    // @ts-expect-error the way out is not optional
    expect(() => createElement(SignInLinkSent, { email: 'ada@yourstore.com' })).not.toThrow()
  })

  /**
   * Read off the source, and it is the only assertion here that can be. The
   * screen reaches this state by a click nothing in this repository can press,
   * so the tests above prove the panel is right without proving the screen uses
   * it. This catches the one mutation they miss: the confirmation drawn inline
   * again, correct on screen and with no way out of it.
   */
  it('is what the screen itself shows, not a second copy of the sentence', () => {
    const source = readFileSync(new URL('./SignIn.tsx', import.meta.url), 'utf8')

    expect(source).toContain('<SignInLinkSent')
    expect(source.split("t('signin.emailSent'")).toHaveLength(2)
  })
})

// ── No amount anywhere ───────────────────────────────────────────────────────

/**
 * The product quoted a live amount read from the payment processor, and never
 * wrote one down. The processor is gone; the rule it enforced is worth keeping
 * as a rule about this repository, because a hardcoded price is how a marketing
 * page and a checkout quietly come to disagree.
 */
describe('the price', () => {
  it('is nowhere on the pricing block', () => {
    const html = render(createElement(LandingPricing, { action: null }))
    expect(html).not.toMatch(/[$€£]\s?\d/)
  })
})

/** Markup with the tags taken out, so an assertion reads what a person reads. */
function text(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ')
}
