import type { ReactNode } from 'react'
import {
  AppShell,
  bannerContextFromAccount,
  navContextFromAccount,
  resolveLanguage,
  createTranslate,
  type ShellAccount,
} from '@sortiva/ui'
import '@sortiva/ui/tokens.css'
import '@sortiva/ui/styles/shell.css'
import { loadShellState } from './_lib/shell-state'

/**
 * Every authenticated screen renders inside this. It fetches the two facts the
 * frame needs — the account, and whether publishing is on holiday — and hands
 * them to the shell, which decides what the rail locks and which notices are
 * raised.
 *
 * Screens themselves know nothing about any of it.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const { account, settings, acceptLanguage } = await loadShellState()

  const t = createTranslate(
    resolveLanguage({
      saved: settings?.uiLanguage ?? null,
      browser: acceptLanguage,
    }),
  )

  return (
    <AppShell
      t={t}
      nav={navContextFromAccount(account as ShellAccount)}
      banners={bannerContextFromAccount(account as ShellAccount, {
        vacationMode: settings?.vacationMode ?? false,
      })}
    >
      {children}
    </AppShell>
  )
}
