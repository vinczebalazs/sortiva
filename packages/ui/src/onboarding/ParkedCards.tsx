import { t as defaultTranslate, type Translate } from '../strings'

/**
 * The two states where an account exists but nothing can run.
 *
 * Both replace the screen rather than sitting on top of it, because in neither
 * case is there a dashboard worth looking at underneath. Both say what still
 * works, which is the point: a merchant who cannot tell whether they have lost
 * their domain, their money or their articles assumes the worst of the three.
 */

export interface ParkedCardProps {
  readonly t?: Translate
  readonly contactHref?: string
}

/**
 * The store is not on Shopify. Ingestion stopped at the first step and there is
 * no self-serve way out in this version — support has to unpark the account —
 * so the card offers a conversation rather than a retry that would fail again.
 *
 * The claim is deliberately kept: releasing the domain would let somebody else
 * take the merchant's own address while we are still talking to them.
 */
export function ParkedUnsupportedCard({ t = defaultTranslate, contactHref = '/contact' }: ParkedCardProps) {
  return (
    <section className="sortiva-onboarding-card sortiva-parked" data-onboarding-card="parked_unsupported">
      <h1 className="sortiva-onboarding-card__heading">
        {t('onboarding.parked.unsupported.heading')}
      </h1>
      <p className="sortiva-onboarding-card__body">{t('appendixA.notShopifyParked')}</p>
      <p className="sortiva-parked__note">{t('onboarding.parked.unsupported.note')}</p>
      <a className="sortiva-onboarding-card__primary" href={contactHref}>
        {t('onboarding.parked.unsupported.contact')}
      </a>
    </section>
  )
}

export interface ParkedShopifyCardProps extends ParkedCardProps {
  readonly reconnectHref?: string
}

/**
 * The Shopify token was revoked — usually the app being uninstalled from the
 * store. Generation and scans stop; everything already made stays readable,
 * which is what the note says in as many words.
 *
 * Reconnecting is the same grant as the first one and lives with the other
 * connections in Settings, so this points there rather than starting a second
 * OAuth flow of its own.
 */
export function ParkedShopifyDisconnectedCard({
  t = defaultTranslate,
  reconnectHref = '/settings/connections',
}: ParkedShopifyCardProps) {
  return (
    <section className="sortiva-onboarding-card sortiva-parked" data-onboarding-card="parked_shopify_disconnected">
      <h1 className="sortiva-onboarding-card__heading">{t('onboarding.parked.shopify.heading')}</h1>
      <p className="sortiva-onboarding-card__body">{t('onboarding.parked.shopify.note')}</p>
      <a className="sortiva-onboarding-card__primary" href={reconnectHref}>
        {t('banner.shopifyReconnect.action')}
      </a>
    </section>
  )
}
