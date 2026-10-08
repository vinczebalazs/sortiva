import { useSearchParams } from 'react-router'
import { App } from '../screens/App.tsx'
import type { Screen } from '../shell/api.tsx'
import { DevShell } from '../shell/shopify.tsx'

// The same screens outside Shopify, signed into a seeded store: /dev?shop=<domain>&locale=hu
export default function DevHost() {
  const [params] = useSearchParams()
  const shop = params.get('shop')
  const screen = (['articles', 'products', 'settings'].includes(params.get('screen') ?? '') ? params.get('screen') : 'home') as Screen
  const article = params.get('article') ? Number(params.get('article')) : undefined
  if (!shop) return <main className="ui-page"><p>Add ?shop=&lt;store domain&gt; to the address.</p></main>
  return (
    <DevShell shopDomain={shop} locale={params.get('locale')}>
      <App key={`${screen}:${article ?? ''}`} screen={screen} articleId={article} />
    </DevShell>
  )
}
