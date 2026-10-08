import { Outlet, useSearchParams } from 'react-router'
import { ShopifyShell } from '../shell/shopify.tsx'

export default function ShopifyHost() {
  const [params] = useSearchParams()
  return (
    <ShopifyShell locale={params.get('locale')}>
      <Outlet />
    </ShopifyShell>
  )
}
