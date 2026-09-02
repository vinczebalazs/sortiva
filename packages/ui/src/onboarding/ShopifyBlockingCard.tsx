'use client'

import { useState } from 'react'
import { t as defaultTranslate, type Translate } from '../strings'

/**
 * The card that replaces the "Connect your store" row while we wait for the
 * merchant to grant read access to Shopify.
 *
 * It blocks: best-seller figures come from order data, which is not on the
 * storefront, and there is no scraping fallback — so nothing after this step
 * can run without it. That makes the trust copy the most load-bearing sentence
 * on the screen. Fear of a tool posting to their store unasked is the main
 * reason a merchant stops here, so the card states that this grant cannot
 * write, and that publishing is a separate permission asked for later, in the
 * exact words the product committed to.
 *
 * The scope names are shown as themselves. They are what Shopify's own consent
 * screen will list a moment later, and a merchant comparing the two should see
 * the same four strings rather than our paraphrase of them.
 */

/**
 * Read-only, and only these four. Publishing needs `write_content`, which is a
 * second grant made from Settings or at a first publish — never bundled here.
 */
const READ_SCOPES = ['read_products', 'read_orders', 'read_content', 'read_locales'] as const

export interface ShopifyBlockingCardProps {
  readonly t?: Translate
  readonly endpoint?: string
}

export function ShopifyBlockingCard({
  t = defaultTranslate,
  endpoint = '/api/shopify/oauth/start',
}: ShopifyBlockingCardProps) {
  const [starting, setStarting] = useState(false)
  const [failed, setFailed] = useState(false)

  async function connect() {
    setStarting(true)
    setFailed(false)
    try {
      const response = await fetch(endpoint, { method: 'POST' })
      if (!response.ok) throw new Error('oauth start failed')
      const { url } = (await response.json()) as { url: string }
      window.location.assign(url)
    } catch {
      setFailed(true)
      setStarting(false)
    }
  }

  return (
    <section className="sortiva-onboarding-card sortiva-shopify" data-onboarding-card="shopify_blocking">
      <h1 className="sortiva-onboarding-card__heading">{t('onboarding.shopify.heading')}</h1>
      <p className="sortiva-onboarding-card__body sortiva-shopify__trust">
        {t('appendixA.shopifyReadOnlyTrust')}
      </p>

      <div className="sortiva-shopify__scopes">
        <h2 className="sortiva-shopify__scopes-heading">{t('onboarding.shopify.scopesHeading')}</h2>
        <ul>
          {READ_SCOPES.map((scope) => (
            <li key={scope}>
              <code>{scope}</code>
            </li>
          ))}
        </ul>
        <p className="sortiva-shopify__scopes-note">{t('onboarding.shopify.scopesNote')}</p>
      </div>

      <button className="sortiva-onboarding-card__primary" type="button" onClick={connect} disabled={starting}>
        {t('onboarding.shopify.connect')}
      </button>

      {failed ? (
        <p className="sortiva-onboarding-card__error" role="alert">
          {t('onboarding.shopify.failed')}
        </p>
      ) : null}
    </section>
  )
}
