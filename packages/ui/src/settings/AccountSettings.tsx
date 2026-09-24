'use client'

import { useState } from 'react'
import { SUPPORTED_LANGUAGES, t as defaultTranslate, type Translate } from '../strings'
import { DeleteAccountModal } from './DeleteAccountModal'
import type { AccountSettingsData, EmailDigestFrequency } from './types'

/**
 * ui §9.4 — vacation mode, email preferences, interface language, and the one
 * irreversible control in the product.
 *
 * No billing card: there is nothing for a merchant to do about payment while
 * the purchase layer is gone, and a card offering a portal that does not exist
 * would be a broken promise on the one screen where trust matters most.
 */

export interface AccountSettingsProps {
  readonly settings: AccountSettingsData
  readonly t?: Translate
  readonly patchEndpoint?: string
  readonly onDeleted?: () => void
}

async function patchSettings(
  endpoint: string,
  patch: Partial<AccountSettingsData>,
): Promise<AccountSettingsData | null> {
  try {
    const response = await fetch(endpoint, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    })
    if (!response.ok) return null
    return (await response.json()) as AccountSettingsData
  } catch {
    return null
  }
}

export function AccountSettings({
  settings: initial,
  t = defaultTranslate,
  patchEndpoint = '/api/settings',
  // The deletion route revokes the session's own tokens but does not clear the
  // browser's cookie, so the caller's job is to leave the authenticated app.
  // The public landing page is the safe default: whatever the cookie still
  // says, every screen behind it re-reads the account and finds none.
  onDeleted = () => window.location.assign('/'),
}: AccountSettingsProps) {
  const [settings, setSettings] = useState(initial)
  const [deleting, setDeleting] = useState(false)

  async function save(patch: Partial<AccountSettingsData>) {
    const previous = settings
    setSettings({ ...settings, ...patch })
    const result = await patchSettings(patchEndpoint, patch)
    if (result) setSettings(result)
    else setSettings(previous)
  }

  return (
    <section className="sortiva-settings__panel" data-settings-section="account">
      <h1>{t('settings.account.heading')}</h1>

      <div className="sortiva-settings__row" data-setting="vacation_mode">
        <div>
          <h2>{t('settings.account.vacation.heading')}</h2>
          <p className="sortiva-settings__note">{t('settings.account.vacation.explain')}</p>
        </div>
        <input
          type="checkbox"
          role="switch"
          checked={settings.vacationMode}
          onChange={(event) => void save({ vacationMode: event.target.checked })}
        />
      </div>

      <div className="sortiva-settings__row" data-setting="email_preferences">
        <h2>{t('settings.account.email.heading')}</h2>
        <label>
          <input
            type="checkbox"
            checked={settings.emailArticlePublished}
            onChange={(event) => void save({ emailArticlePublished: event.target.checked })}
          />
          {t('settings.account.email.articlePublished')}
        </label>
        <label>
          {t('settings.account.email.digest.heading')}
          <select
            value={settings.emailDigestFrequency}
            onChange={(event) =>
              void save({ emailDigestFrequency: event.target.value as EmailDigestFrequency })
            }
          >
            <option value="off">{t('settings.account.email.digest.off')}</option>
            <option value="daily">{t('settings.account.email.digest.daily')}</option>
            <option value="weekly">{t('settings.account.email.digest.weekly')}</option>
          </select>
        </label>
      </div>

      <div className="sortiva-settings__row" data-setting="ui_language">
        <h2>{t('settings.account.language.heading')}</h2>
        <select
          aria-label={t('settings.account.language.heading')}
          value={settings.uiLanguage ?? ''}
          onChange={(event) => void save({ uiLanguage: event.target.value || null })}
        >
          {SUPPORTED_LANGUAGES.map((language) => (
            <option key={language} value={language}>
              {language.toUpperCase()}
            </option>
          ))}
        </select>
      </div>

      <div className="sortiva-settings__danger-zone" data-setting="delete_account">
        <h2>{t('settings.account.dangerZone.heading')}</h2>
        <button type="button" className="sortiva-settings__danger-button" onClick={() => setDeleting(true)}>
          {t('settings.deleteAccount.heading')}
        </button>
      </div>

      {deleting ? (
        <DeleteAccountModal
          t={t}
          onClose={() => setDeleting(false)}
          onDeleted={() => onDeleted?.()}
        />
      ) : null}
    </section>
  )
}
