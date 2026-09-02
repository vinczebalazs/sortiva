import type { ReactNode } from 'react'
import '@sortiva/ui/tokens.css'
import '@sortiva/ui/styles/public.css'

/**
 * The frame around everything a visitor can reach without an account. It
 * deliberately shares nothing with the app frame: there is no navigation rail
 * and no account strip here, because there is no account yet.
 */
export default function PublicLayout({ children }: { children: ReactNode }) {
  return <div className="sortiva-public">{children}</div>
}
