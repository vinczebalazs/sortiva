import { t as defaultTranslate, type Translate } from '../strings'
import { CloseIcon, InfoIcon } from './icons'
import {
  MAX_VISIBLE_BANNERS,
  resolveBannerStack,
  type BannerContext,
  type BannerDefinition,
  type BannerId,
} from './banners'

export interface BannerStackProps {
  readonly context: BannerContext
  readonly t?: Translate
  /**
   * Called when the merchant closes a dismissible banner. The caller keeps the
   * dismissed list, because "dismissed for this session" is the caller's state
   * to own — this component renders what it is given.
   */
  readonly onDismiss?: (id: BannerId) => void
  /** Where the counted-but-hidden notices can be read. */
  readonly notificationsHref?: string
}

function Banner({
  banner,
  t,
  onDismiss,
}: {
  banner: BannerDefinition
  t: Translate
  onDismiss?: (id: BannerId) => void
}) {
  return (
    <div
      className={`sortiva-banner sortiva-banner--${banner.tone}`}
      role={banner.tone === 'critical' ? 'alert' : 'status'}
      data-banner={banner.id}
      data-banner-tone={banner.tone}
    >
      <InfoIcon className="sortiva-banner__icon" />
      <p className="sortiva-banner__message">{t(banner.messageKey)}</p>
      {banner.actionKey && banner.actionHref ? (
        <a className="sortiva-banner__action" href={banner.actionHref}>
          {t(banner.actionKey)}
        </a>
      ) : null}
      {banner.dismissible ? (
        <button
          type="button"
          className="sortiva-banner__dismiss"
          aria-label={t('banner.dismiss')}
          onClick={onDismiss ? () => onDismiss(banner.id) : undefined}
        >
          <CloseIcon />
        </button>
      ) : null}
    </div>
  )
}

/**
 * At most two notices are on screen. Anything else that is raised is counted
 * and pointed at the notifications list, so nothing is hidden without saying
 * so — a merchant who is told there is one more notice can go and find it.
 */
export function BannerStack({
  context,
  t = defaultTranslate,
  onDismiss,
  notificationsHref = '/notifications',
}: BannerStackProps) {
  const { visible, overflow } = resolveBannerStack(context)
  if (visible.length === 0) return null

  return (
    <div
      className="sortiva-banner-stack"
      aria-label={t('banner.stackLabel')}
      role="region"
      data-visible-banners={visible.length}
      data-max-visible-banners={MAX_VISIBLE_BANNERS}
    >
      {visible.map((banner) => (
        <Banner key={banner.id} banner={banner} t={t} onDismiss={onDismiss} />
      ))}
      {overflow.length > 0 ? (
        <a className="sortiva-banner-stack__overflow" href={notificationsHref} data-banner-overflow={overflow.length}>
          {overflow.length === 1
            ? t('banner.overflow.one')
            : t('banner.overflow.many', { count: overflow.length })}
        </a>
      ) : null}
    </div>
  )
}
