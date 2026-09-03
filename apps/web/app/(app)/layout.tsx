import type { ReactNode } from 'react'
import {
  AppShell,
  bannerContextFromAccount,
  navContextFromAccount,
  NotificationBell,
  resolveLanguage,
  createTranslate,
  type ShellAccount,
} from '@sortiva/ui'
import '@sortiva/ui/tokens.css'
import '@sortiva/ui/styles/shell.css'
import { loadShellState } from './_lib/shell-state'
import { browserAnalyticsConfig } from './_lib/analytics'
import { AnalyticsMount } from './_lib/AnalyticsMount'

/**
 * Every authenticated screen renders inside this. It fetches the two facts the
 * frame needs — the account, and whether publishing is on holiday — and hands
 * them to the shell, which decides what the rail locks and which notices are
 * raised.
 *
 * It is also where reporting is switched on, because this is the outermost
 * thing every authenticated screen has in common. The public pages are outside
 * it deliberately: everything their funnel needs is already recorded by the
 * server as the work happens, so putting a second copy in the browser would
 * only make the two disagree.
 *
 * Screens themselves know nothing about any of it.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const { account, settings, acceptLanguage } = await loadShellState()
  const analytics = browserAnalyticsConfig()

  const language = resolveLanguage({
    saved: settings?.uiLanguage ?? null,
    browser: acceptLanguage,
  })
  const t = createTranslate(language)

  return (
    <AnalyticsMount
      accountId={account.accountId ?? null}
      domain={account.domain?.normalized ?? null}
      projectKey={analytics.projectKey}
      host={analytics.host}
    >
      <AppShell
        t={t}
        nav={navContextFromAccount(account as ShellAccount)}
        banners={bannerContextFromAccount(account as ShellAccount, {
          vacationMode: settings?.vacationMode ?? false,
        })}
        // `NotificationBell` is a Client Component; it takes the language
        // code and builds its own translator rather than receiving this
        // Server Component's `t` closure, which React cannot serialise
        // across that boundary (see the component's own comment).
        toolbar={account.accountId ? <NotificationBell language={language} /> : null}
      >
        {children}
      </AppShell>
    </AnalyticsMount>
  )
}
