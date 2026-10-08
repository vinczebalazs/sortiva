import { Link } from 'react-router'
import type { Banner as BannerState } from '../../core/status.ts'
import { useHost } from '../shell/api.tsx'
import { Banner } from '../ui/components.tsx'

/** Conditions that stop work, one sentence each, shown at the top of every screen while they hold. */
export function Banners({ banners, onChange }: { banners: BannerState[]; onChange: () => void }) {
  const { t, post, href } = useHost()
  const b = t.banners
  return (
    <>
      {banners.map((banner) => {
        switch (banner.kind) {
          case 'not_entitled':
            return <Banner key={banner.kind} tone="warning">{b.not_entitled}</Banner>
          case 'paused_by_merchant':
            return (
              <Banner key={banner.kind} tone="warning">
                {b.paused_by_merchant}{' '}
                <button className="ui-link-button" onClick={async () => { await post('/api/settings', { section: 'pause', paused: false }); onChange() }}>{b.resume}</button>
              </Banner>
            )
          case 'budget_reached':
            return <Banner key={banner.kind} tone="warning">{b.budget_reached}</Banner>
          case 'permission_lost':
            return (
              <Banner key={banner.kind} tone="critical">
                {b.permission_lost(banner.scopes.map((s) => b.permissionNames[s] ?? s).join(', '))} {b.reinstall}
              </Banner>
            )
          case 'no_blog':
            return <Banner key={banner.kind} tone="warning">{b.no_blog} <Link to={href('settings')}>{b.chooseBlog}</Link></Banner>
          case 'gsc_disconnected':
            return <Banner key={banner.kind} tone="warning">{b.gsc_disconnected} <Link to={href('settings')}>{b.reconnect}</Link></Banner>
        }
      })}
    </>
  )
}

