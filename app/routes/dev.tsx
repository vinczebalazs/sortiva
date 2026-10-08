import { useSearchParams } from 'react-router'
import { Setup } from '../screens/Setup.tsx'
import { DevShell } from '../shell/shopify.tsx'

// The same screens outside Shopify, signed into a seeded store: /dev?shop=<domain>&locale=hu
export default function DevHost() {
  const [params] = useSearchParams()
  const shop = params.get('shop')
  if (!shop) return <main className="ui-page"><p>Add ?shop=&lt;store domain&gt; to the address.</p></main>
  return (
    <DevShell shopDomain={shop} locale={params.get('locale')}>
      <Setup />
    </DevShell>
  )
}
