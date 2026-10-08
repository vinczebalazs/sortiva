import type { ReactNode } from 'react'
import { Link, useLocation } from 'react-router'
import { MESSAGES, uiLanguage } from '../i18n/messages.ts'
import { HostProvider, type Screen } from './api.tsx'

declare global {
  interface Window {
    shopify?: { idToken: () => Promise<string> }
  }
}

// App Bridge's navigation element, loaded from Shopify's CDN in root.tsx.
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      's-app-nav': { children?: ReactNode }
    }
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
      adminLink={(page, platformId) => `shopify://admin/${page}${platformId ? `/${numericId(platformId)}` : ''}`}
      href={(screen, id) => (id === undefined ? SHOPIFY_PATHS[screen] : `/app/articles/${id}`)}
      Nav={() => <ShopifyNav locale={locale} />}
    >
      {children}
    </HostProvider>
  )
}

/** Local preview and browser tests: signs straight into a seeded store when the server allows it. */
export function DevShell({ shopDomain, locale, children }: { shopDomain: string; locale: string | null; children: ReactNode }) {
  return (
    <HostProvider
      locale={locale}
      signIn={() => exchange('/api/dev/session', { shopDomain })}
      adminLink={(page, platformId) => `https://${shopDomain}/admin/${page}${platformId ? `/${numericId(platformId)}` : ''}`}
      href={(screen, id) => devHref(shopDomain, locale, screen, id)}
      Nav={() => <DevNav shopDomain={shopDomain} locale={locale} />}
    >
      {children}
    </HostProvider>
  )
}

const numericId = (platformId: string) => platformId.split('/').pop()

const SHOPIFY_PATHS: Record<Screen, string> = { home: '/app', articles: '/app/articles', products: '/app/products', settings: '/app/settings' }

/** The entries in Shopify's own left-hand navigation; the admin draws them, not us. */
function ShopifyNav({ locale }: { locale: string | null }) {
  const t = MESSAGES[uiLanguage(locale)]
  return (
    <s-app-nav>
      <a href={SHOPIFY_PATHS.home} rel="home">{t.nav.home}</a>
      <a href={SHOPIFY_PATHS.articles}>{t.nav.articles}</a>
      <a href={SHOPIFY_PATHS.products}>{t.nav.products}</a>
      <a href={SHOPIFY_PATHS.settings}>{t.nav.settings}</a>
    </s-app-nav>
  )
}

function devHref(shopDomain: string, locale: string | null, screen: Screen, articleId?: number): string {
  const params = new URLSearchParams({ shop: shopDomain, ...(locale ? { locale } : {}), ...(screen === 'home' ? {} : { screen }), ...(articleId === undefined ? {} : { article: String(articleId) }) })
  return `/dev?${params}`
}

/** Outside Shopify there is no admin sidebar, so the preview draws a plain row of links in its place. */
function DevNav({ shopDomain, locale }: { shopDomain: string; locale: string | null }) {
  const t = MESSAGES[uiLanguage(locale)]
  const current = new URLSearchParams(useLocation().search).get('screen') ?? 'home'
  return (
    <nav className="ui-devnav">
      {(['home', 'articles', 'products', 'settings'] as const).map((screen) => (
        <Link key={screen} to={devHref(shopDomain, locale, screen)} data-current={current === screen || undefined}>{t.nav[screen]}</Link>
      ))}
    </nav>
  )
}
