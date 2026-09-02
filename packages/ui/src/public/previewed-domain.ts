/**
 * The address a visitor typed into the landing page, kept until the connect
 * step can offer it back.
 *
 * It is a **suggestion and never a claim**. A domain claim is exclusive — one
 * made on somebody's behalf would lock a business out of its own address — so
 * nothing here does more than remember what was typed, and the connect step
 * still asks.
 *
 * It is kept in the tab rather than in a link because the journey from the
 * landing page to the connect step leaves our site: sign-in goes via the
 * identity provider and the plan screen goes via Stripe Checkout, and a query
 * parameter does not survive either hop. Per-tab storage does, and it costs
 * nothing if the visitor closes the tab: the connect step simply asks with an
 * empty field, which is what it does for anyone who never used the preview.
 *
 * Nothing the preview produced travels with it — only the address, which the
 * visitor typed themselves. The preview's own output is disposable and never
 * reaches ingestion.
 */

const KEY = 'sortiva.previewedDomain'

/** Storage is absent in server rendering and can throw where the browser blocks it. */
function session(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage
  } catch {
    return null
  }
}

export function rememberPreviewedDomain(domain: string | null | undefined): void {
  const store = session()
  if (!store) return
  try {
    if (domain) store.setItem(KEY, domain)
    else store.removeItem(KEY)
  } catch {
    // A tab with storage disabled still signs in; the connect step just asks.
  }
}

export function readPreviewedDomain(): string | null {
  const store = session()
  if (!store) return null
  try {
    return store.getItem(KEY)
  } catch {
    return null
  }
}

export function forgetPreviewedDomain(): void {
  rememberPreviewedDomain(null)
}
