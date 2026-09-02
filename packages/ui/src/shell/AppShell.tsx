import type { ReactNode } from 'react'
import { t as defaultTranslate, type Translate } from '../strings'
import { BannerStack } from './BannerStack'
import { NavRail } from './NavRail'
import type { BannerContext, BannerId } from './banners'
import type { NavContext } from './nav'

/**
 * The frame every authenticated screen renders inside: the icon rail, the strip
 * of account notices, and the screen itself.
 *
 * The shell knows nothing about any particular screen. It is given the handful
 * of account facts that decide what the rail locks and which notices are
 * raised, and renders whatever it is handed underneath.
 */

export interface AppShellProps {
  readonly nav: NavContext
  readonly banners: BannerContext
  readonly children: ReactNode
  readonly t?: Translate
  readonly onDismissBanner?: (id: BannerId) => void
  /**
   * Replaces the screen entirely. Some account states leave nothing useful to
   * show — an unsupported platform, for one — and the shell stays around it so
   * the merchant can still reach Settings.
   */
  readonly parked?: ReactNode
  /** The bell, the avatar and anything else a screen wants in the top strip. */
  readonly toolbar?: ReactNode
}

export function AppShell({
  nav,
  banners,
  children,
  t = defaultTranslate,
  onDismissBanner,
  parked,
  toolbar,
}: AppShellProps) {
  return (
    <div className="sortiva-shell" data-parked={parked ? 'true' : undefined}>
      <a className="sortiva-shell__skip" href="#sortiva-main">
        {t('shell.skipToContent')}
      </a>
      <NavRail context={nav} t={t} />
      <div className="sortiva-shell__body">
        {toolbar ? <div className="sortiva-shell__toolbar">{toolbar}</div> : null}
        <BannerStack context={banners} t={t} onDismiss={onDismissBanner} />
        <main className="sortiva-shell__main" id="sortiva-main">
          {parked ?? children}
        </main>
      </div>
    </div>
  )
}
