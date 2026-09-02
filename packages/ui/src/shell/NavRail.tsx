import { t as defaultTranslate, type Translate } from '../strings'
import { BrandMark, LockIcon, NAV_ICONS } from './icons'
import { isInteractive, resolveNav, type NavContext, type ResolvedNavItem } from './nav'

/**
 * The vertical icon rail down the left of every authenticated screen.
 *
 * A locked destination stays in place rather than disappearing: a merchant part
 * way through connecting their store can see what they are about to get, and
 * the tooltip says what will unlock it. Hiding them instead would make the
 * product look like it changed shape underneath them.
 */

export interface NavRailProps {
  readonly context: NavContext
  readonly t?: Translate
}

function NavRailItem({ item, t }: { item: ResolvedNavItem; t: Translate }) {
  const IconComponent = NAV_ICONS[item.id]
  const label = t(item.labelKey)
  const locked = item.status === 'locked'
  const title = locked && item.lockedReasonKey ? t(item.lockedReasonKey) : undefined
  const pending = item.pendingKey ? t(item.pendingKey) : undefined

  const className = [
    'sortiva-nav__item',
    item.status === 'current' ? 'sortiva-nav__item--current' : '',
    locked ? 'sortiva-nav__item--locked' : '',
  ]
    .filter(Boolean)
    .join(' ')

  const body = (
    <>
      <IconComponent />
      {locked ? <LockIcon className="sortiva-nav__lock" /> : null}
      {pending ? <span className="sortiva-nav__spinner" aria-hidden="true" /> : null}
    </>
  )

  // A locked item is not a link: it is announced as disabled and cannot be
  // reached by keyboard or by typing the URL into the address bar of a
  // screen-reader's link list. A greyed-out anchor that still navigates is the
  // classic way "non-interactive" turns out to be interactive after all.
  if (locked) {
    return (
      <span
        className={className}
        role="link"
        aria-disabled="true"
        aria-label={`${label} — ${title ?? ''}`.trim()}
        title={title}
        data-nav-item={item.id}
        data-nav-status={item.status}
      >
        {body}
      </span>
    )
  }

  return (
    <a
      className={className}
      href={item.href}
      aria-label={pending ? `${label} — ${pending}` : label}
      aria-current={item.status === 'current' ? 'page' : undefined}
      title={pending ?? label}
      data-nav-item={item.id}
      data-nav-status={item.status}
      data-nav-pending={pending ? 'true' : undefined}
    >
      {body}
    </a>
  )
}

export function NavRail({ context, t = defaultTranslate }: NavRailProps) {
  const items = resolveNav(context)
  const anyLocked = items.some((item) => !isInteractive(item))

  return (
    <nav className="sortiva-nav" aria-label={t('nav.label')} data-testid="nav-rail">
      <span className="sortiva-nav__brand" aria-label={t('nav.brand')} role="img">
        <BrandMark />
      </span>
      <ul className="sortiva-nav__list">
        {items.map((item) => (
          <li key={item.id}>
            <NavRailItem item={item} t={t} />
          </li>
        ))}
      </ul>
      {anyLocked ? (
        <span className="sortiva-nav__lock-note" title={t('nav.lockedTooltip')}>
          <LockIcon />
        </span>
      ) : null}
    </nav>
  )
}
