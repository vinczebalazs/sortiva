import { createTranslate } from '@sortiva/ui'

/**
 * The single settings area's left sub-nav (ui §9): four destinations, none of
 * them locked before the store connects — Settings is where a merchant reaches
 * billing and their own account even before there is a store to plan around.
 */

const t = createTranslate()

export type SettingsTab = 'publishing' | 'profile' | 'connections' | 'account'

const TABS: readonly { readonly id: SettingsTab; readonly href: string; readonly labelKey: Parameters<typeof t>[0] }[] = [
  { id: 'publishing', href: '/settings/publishing', labelKey: 'settings.nav.publishing' },
  { id: 'profile', href: '/settings/profile', labelKey: 'settings.nav.profile' },
  { id: 'connections', href: '/settings/connections', labelKey: 'settings.nav.connections' },
  { id: 'account', href: '/settings/account', labelKey: 'settings.nav.account' },
]

export function SettingsNav({ current }: { readonly current: SettingsTab }) {
  return (
    <nav className="sortiva-settings__nav" aria-label={t('settings.nav.label')}>
      {TABS.map((tab) => (
        <a key={tab.id} href={tab.href} aria-current={current === tab.id ? 'page' : undefined}>
          {t(tab.labelKey)}
        </a>
      ))}
    </nav>
  )
}
