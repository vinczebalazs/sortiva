import { useEffect, useState } from 'react'
import type { Banner } from '../../core/status.ts'
import { useHost, type Screen } from '../shell/api.tsx'
import { Banners } from './Banners.tsx'
import { Home } from './Home.tsx'
import { Products } from './Products.tsx'
import { Settings } from './Settings.tsx'
import { Setup } from './Setup.tsx'

/** Setup until it is finished; after that the host's navigation, the banners, and the requested screen. */
export function App({ screen }: { screen: Screen }) {
  const { Nav, get } = useHost()
  const [ready, setReady] = useState(false)
  const [banners, setBanners] = useState<Banner[]>([])
  // Bumped when a banner action changes the store's state, so the screen below reloads too.
  const [version, setVersion] = useState(0)
  useEffect(() => {
    if (ready) get<Banner[]>('/api/banners').then(setBanners)
  }, [ready, version])

  if (!ready) return <Setup onDone={() => setReady(true)} />
  return (
    <>
      <Nav />
      {banners.length > 0 && (
        <div className="ui-page" style={{ paddingBottom: 0, gap: 10 }}>
          <Banners banners={banners} onChange={() => setVersion((v) => v + 1)} />
        </div>
      )}
      <div key={version}>
        {screen === 'home' && <Home />}
        {screen === 'products' && <Products />}
        {screen === 'settings' && <Settings onPauseChanged={() => setVersion((v) => v + 1)} />}
      </div>
    </>
  )
}
