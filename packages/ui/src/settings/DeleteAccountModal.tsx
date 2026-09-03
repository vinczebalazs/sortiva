'use client'

import { useState } from 'react'
import { t as defaultTranslate, type Translate } from '../strings'

/**
 * ui §9.4's danger zone: a type-to-confirm modal stating the main §14.6 facts
 * before an irreversible action.
 *
 * The confirm button stays off until the merchant has typed the exact word
 * back — a click is not deliberate enough for something this permanent, and
 * the route itself refuses anything else (`POST /api/account/delete`), so the
 * button state is a courtesy rather than the only thing enforcing it.
 */

const CONFIRM_WORD = 'DELETE'

export interface DeleteAccountModalProps {
  readonly t?: Translate
  readonly onClose: () => void
  /** Called once the account is actually deleted, so the caller can sign the merchant out. */
  readonly onDeleted: () => void
  readonly endpoint?: string
}

export function DeleteAccountModal({
  t = defaultTranslate,
  onClose,
  onDeleted,
  endpoint = '/api/account/delete',
}: DeleteAccountModalProps) {
  const [typed, setTyped] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [failed, setFailed] = useState(false)

  const ready = typed === CONFIRM_WORD

  async function confirm() {
    if (!ready || submitting) return
    setSubmitting(true)
    setFailed(false)
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmation: typed }),
      })
      if (!response.ok) throw new Error('delete failed')
      onDeleted()
    } catch {
      setFailed(true)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="sortiva-settings__modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="sortiva-settings__modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('settings.deleteAccount.heading')}
        data-setting="delete_account"
        onClick={(event) => event.stopPropagation()}
      >
        <h2>{t('settings.deleteAccount.heading')}</h2>

        <ul className="sortiva-settings__facts-list">
          <li>{t('settings.deleteAccount.fact.noFurtherCharges')}</li>
          <li>{t('settings.deleteAccount.fact.articlesStay')}</li>
          <li>{t('settings.deleteAccount.fact.grantsReturned')}</li>
          <li>{t('settings.deleteAccount.fact.domainReserved')}</li>
          <li>{t('settings.deleteAccount.fact.dataErased')}</li>
        </ul>

        <label htmlFor="sortiva-delete-confirm">{t('settings.deleteAccount.confirmLabel')}</label>
        <input
          id="sortiva-delete-confirm"
          value={typed}
          autoComplete="off"
          onChange={(event) => setTyped(event.target.value)}
        />

        {failed ? (
          <p className="sortiva-settings__error" role="alert">
            {t('settings.publishing.saveFailed')}
          </p>
        ) : null}

        <div className="sortiva-settings__modal-actions">
          <button type="button" onClick={onClose} disabled={submitting}>
            {t('settings.deleteAccount.cancel')}
          </button>
          <button
            type="button"
            className="sortiva-settings__danger-button"
            disabled={!ready || submitting}
            onClick={() => void confirm()}
          >
            {t('settings.deleteAccount.submit')}
          </button>
        </div>
      </div>
    </div>
  )
}
