import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { MESSAGES, uiLanguage, type Messages, type UiLanguage } from '../i18n/messages.ts'

export type Screen = 'home' | 'products' | 'settings'

/** What every screen gets from its host: an API client with our bearer token, and the copy. */
export type Host = {
  get: <T>(path: string) => Promise<T>
  post: <T>(path: string, body: unknown) => Promise<{ status: number; body: T }>
  t: Messages
  language: UiLanguage
  /** Opens a page of the host platform's admin: the product list, or one product by its platform id. */
  adminLink: (page: 'products', platformId?: string) => string
  /** Where one of our screens lives in this host. */
  href: (screen: Screen) => string
  /** The host's navigation, shown once setup is done. */
  Nav: () => ReactNode
}

const HostContext = createContext<Host | null>(null)

export function useHost(): Host {
  const host = useContext(HostContext)
  if (!host) throw new Error('screens must be rendered inside a host shell')
  return host
}

/**
 * Signs in with whatever the platform proves about the merchant (a session token here),
 * then talks to our API with our own token, signing in again when it expires.
 */
export function HostProvider(props: {
  signIn: () => Promise<string>
  locale: string | null
  adminLink: Host['adminLink']
  href: Host['href']
  Nav: Host['Nav']
  children: ReactNode
}) {
  const [state, setState] = useState<{ host: Host } | { error: true } | null>(null)

  useEffect(() => {
    let token: string | null = null
    const authed = async (path: string, init: RequestInit = {}): Promise<Response> => {
      for (let attempt = 0; attempt < 2; attempt++) {
        token ??= await props.signIn()
        const res = await fetch(path, { ...init, headers: { ...init.headers, authorization: `Bearer ${token}`, 'content-type': 'application/json' } })
        if (res.status !== 401) return res
        token = null
      }
      throw new Error('sign-in failed twice')
    }
    const host: Host = {
      get: async (path) => (await (await authed(path)).json()) as never,
      post: async (path, body) => {
        const res = await authed(path, { method: 'POST', body: JSON.stringify(body) })
        return { status: res.status, body: (await res.json()) as never }
      },
      t: MESSAGES[uiLanguage(props.locale)],
      language: uiLanguage(props.locale),
      adminLink: props.adminLink,
      href: props.href,
      Nav: props.Nav,
    }
    props.signIn().then(
      (t) => {
        token = t
        setState({ host })
      },
      () => setState({ error: true }),
    )
  }, [])

  const t = MESSAGES[uiLanguage(props.locale)]
  if (!state) return <main className="ui-page"><p className="ui-muted">{t.loading}</p></main>
  if ('error' in state) return <main className="ui-page"><div className="ui-banner" data-tone="critical">{t.signInFailed}</div></main>
  return <HostContext.Provider value={state.host}>{props.children}</HostContext.Provider>
}
