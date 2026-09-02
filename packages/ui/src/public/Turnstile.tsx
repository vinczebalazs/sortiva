'use client'

import { useEffect, useRef } from 'react'

/**
 * Cloudflare's bot check, which every preview request has to carry.
 *
 * It runs in "interaction only" mode: an ordinary visitor sees nothing at all
 * and a token is issued in the background, and only a request Cloudflare finds
 * suspicious is shown a checkbox. That is why the hero has a line of text
 * saying the check exists — otherwise nobody would know.
 *
 * The token this produces proves nothing on its own. It is verified server-side
 * before the endpoint fetches anything, because a check the browser could skip
 * would be no check at all.
 */

interface TurnstileApi {
  render: (
    element: HTMLElement,
    options: {
      sitekey: string
      appearance?: 'always' | 'execute' | 'interaction-only'
      callback?: (token: string) => void
      'expired-callback'?: () => void
      'error-callback'?: () => void
    },
  ) => string
  remove: (widgetId: string) => void
}

declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'

let scriptPromise: Promise<void> | undefined

function loadScript(): Promise<void> {
  if (typeof document === 'undefined') return Promise.reject(new Error('no document'))
  scriptPromise ??= new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${SCRIPT_SRC}"]`)
    if (existing) {
      if (window.turnstile) resolve()
      else existing.addEventListener('load', () => resolve(), { once: true })
      return
    }
    const script = document.createElement('script')
    script.src = SCRIPT_SRC
    script.async = true
    script.defer = true
    script.addEventListener('load', () => resolve(), { once: true })
    script.addEventListener('error', () => reject(new Error('turnstile script failed')), {
      once: true,
    })
    document.head.append(script)
  })
  return scriptPromise
}

export interface TurnstileProps {
  /** Public site key. Nothing renders without one. */
  readonly siteKey: string
  readonly onToken: (token: string | null) => void
}

export function Turnstile({ siteKey, onToken }: TurnstileProps) {
  const host = useRef<HTMLDivElement>(null)
  // Kept in a ref so re-rendering the parent — which happens on every keystroke
  // in the address field — never tears down and re-mounts the widget.
  const latest = useRef(onToken)
  latest.current = onToken

  useEffect(() => {
    let widgetId: string | undefined
    let cancelled = false

    loadScript()
      .then(() => {
        if (cancelled || !host.current || !window.turnstile) return
        widgetId = window.turnstile.render(host.current, {
          sitekey: siteKey,
          appearance: 'interaction-only',
          callback: (token) => latest.current(token),
          'expired-callback': () => latest.current(null),
          'error-callback': () => latest.current(null),
        })
      })
      .catch(() => {
        // A blocked or unreachable Cloudflare script leaves the visitor with no
        // token; the request then fails server-side and the funnel shows its
        // fallback card rather than an error.
        latest.current(null)
      })

    return () => {
      cancelled = true
      if (widgetId && window.turnstile) window.turnstile.remove(widgetId)
    }
  }, [siteKey])

  return <div className="sortiva-turnstile" ref={host} data-testid="turnstile" />
}
