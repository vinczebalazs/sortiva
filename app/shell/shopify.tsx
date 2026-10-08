import type { ReactNode } from 'react'
import { HostProvider } from './api.tsx'

declare global {
  interface Window {
    shopify?: { idToken: () => Promise<string> }
  }
}

async function exchange(path: string, body: unknown): Promise<string> {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`sign-in refused: ${res.status}`)
  return ((await res.json()) as { token: string }).token
}

/** The Shopify host: App Bridge proves who the merchant is; the screens never see a Shopify token. */
export function ShopifyShell({ locale, children }: { locale: string | null; children: ReactNode }) {
  return (
    <HostProvider
      locale={locale}
      signIn={async () => exchange('/api/session', { sessionToken: await window.shopify!.idToken() })}
      adminLink={(page) => `shopify://admin/${page}`}
    >
      {children}
    </HostProvider>
  )
}

/** Local preview and browser tests: signs straight into a seeded store when the server allows it. */
export function DevShell({ shopDomain, locale, children }: { shopDomain: string; locale: string | null; children: ReactNode }) {
  return (
    <HostProvider locale={locale} signIn={() => exchange('/api/dev/session', { shopDomain })} adminLink={(page) => `https://${shopDomain}/admin/${page}`}>
      {children}
    </HostProvider>
  )
}
