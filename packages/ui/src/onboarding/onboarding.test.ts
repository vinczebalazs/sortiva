import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { t } from '../strings'
import { ParkedShopifyDisconnectedCard, ParkedUnsupportedCard } from './ParkedCards'
import { ShopifyBlockingCard } from './ShopifyBlockingCard'
import { Stepper } from './Stepper'
import { ONBOARDING_STEPS, type IngestionStatus, type JobStep, type JobStepName, type JobStepState } from './steps'

const AT = '2026-02-02T09:00:00.000Z'
const NOW = Date.parse(AT)

/**
 * React escapes apostrophes and ampersands on the way out, so markup never
 * contains the sentence a merchant reads. These assertions are about the words,
 * so the entities are turned back into characters first.
 */
const render = (element: Parameters<typeof renderToStaticMarkup>[0]) =>
  renderToStaticMarkup(element)
    .replaceAll('&#x27;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&amp;', '&')

function step(name: JobStepName, state: JobStepState, startedAt: string | null = AT): JobStep {
  return { step: name, state, startedAt, updatedAt: AT, attempts: 1 }
}

function run(steps: readonly JobStep[]): IngestionStatus {
  return { jobId: 'job-1', status: 'running', steps, startedAt: AT }
}

// ── The progress list ────────────────────────────────────────────────────────

describe('the setup progress list', () => {
  const html = render(
    createElement(Stepper, {
      status: run([
        step('detect', 'succeeded'),
        step('oauth_wait', 'succeeded'),
        step('catalog_sync', 'running'),
        step('gsc_connect', 'skipped', null),
      ]),
      domain: 'terrafirma.co.uk',
      now: NOW + 160_000,
    }),
  )

  it('draws seven rows and no more', () => {
    expect(html).toContain('data-stepper-rows="7"')
    expect([...html.matchAll(/data-step="/g)]).toHaveLength(7)
  })

  it('labels each of them from the string catalogue', () => {
    for (const definition of ONBOARDING_STEPS) {
      expect(html).toContain(t(definition.labelKey))
    }
  })

  it('names the store being read', () => {
    expect(html).toContain('Reading terrafirma.co.uk')
  })

  it('marks a declined Search Console step as skipped, in the words the spec gives', () => {
    expect(html).toContain('data-step="search_console" data-step-state="skipped"')
    expect(html).toContain(t('onboarding.step.skipped'))
  })

  it('explains a long-running step rather than leaving a still spinner', () => {
    expect(html).toContain(t('onboarding.step.stillWorking'))
    expect(html).toContain('2m 40s')
  })
})

describe('a failed step', () => {
  it('says a retry is coming and asks nothing of the merchant', () => {
    const html = render(
      createElement(Stepper, { status: run([step('catalog_sync', 'failed_retryable')]), now: NOW }),
    )
    expect(html).toContain(t('onboarding.step.failure.heading'))
    expect(html).toContain(t('onboarding.step.failure.body'))
    expect(html).not.toContain(t('onboarding.support'))
  })

  it('offers a person once nothing will retry it', () => {
    const html = render(
      createElement(Stepper, { status: run([step('catalog_sync', 'failed_terminal')]), now: NOW }),
    )
    expect(html).toContain(t('onboarding.step.failure.stopped'))
    expect(html).toContain(t('onboarding.support'))
  })
})

// ── The Shopify grant ────────────────────────────────────────────────────────

describe('the Shopify blocking card', () => {
  const html = render(createElement(ShopifyBlockingCard, {}))

  it('carries the read-only trust copy word for word', () => {
    expect(html).toContain(
      "Read-only — we can't change anything in your store with this permission. " +
        'Auto-publishing is a separate optional setting you control later.',
    )
  })

  it('names the four read scopes it asks for', () => {
    for (const scope of ['read_products', 'read_orders', 'read_content', 'read_locales']) {
      expect(html).toContain(scope)
    }
  })

  it('asks for no write permission of any kind', () => {
    expect(html).not.toMatch(/write_[a-z]+/)
  })
})

// ── Parked ───────────────────────────────────────────────────────────────────

describe('the parked states', () => {
  it('tells an unsupported store what happened, in the words the spec pins', () => {
    const html = render(createElement(ParkedUnsupportedCard, {}))
    expect(html).toContain(
      "This doesn't look like a Shopify store. We currently support Shopify only — " +
        'contact us for a custom solution or join the waitlist.',
    )
    expect(html).toContain(t('onboarding.parked.unsupported.note'))
  })

  it('tells a disconnected store that its history is still readable', () => {
    const html = render(createElement(ParkedShopifyDisconnectedCard, {}))
    expect(html).toContain(t('onboarding.parked.shopify.heading'))
    expect(html).toContain(t('onboarding.parked.shopify.note'))
    expect(html).toContain('/settings/connections')
  })
})

// ── The cap is a ceiling, never a target ─────────────────────────────────────

describe('nothing in onboarding renders a count against a denominator', () => {
  const surfaces = [
    render(
      createElement(Stepper, {
        status: run([step('detect', 'succeeded'), step('catalog_sync', 'running')]),
        domain: 'terrafirma.co.uk',
        now: NOW + 160_000,
      }),
    ),
    render(createElement(ShopifyBlockingCard, {})),
    render(createElement(ParkedUnsupportedCard, {})),
    render(createElement(ParkedShopifyDisconnectedCard, {})),
  ]

  it('renders no "x of y" and no "x/y"', () => {
    for (const html of surfaces) {
      const text = html.replace(/<[^>]*>/g, ' ')
      expect(text).not.toMatch(/\b\d+\s*(of|\/)\s*\d+\b/)
    }
  })
})
