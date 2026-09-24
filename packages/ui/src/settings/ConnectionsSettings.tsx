'use client'

import { useState } from 'react'
import { SearchConsoleStep } from '../onboarding/SearchConsoleStep'
import { LimitedIntelligenceBadge } from '../shell'
import { t as defaultTranslate, type StringKey, type Translate } from '../strings'
import type { SettingsAccountView } from './types'

/**
 * ui §9.3 — the two accounts this product needs, and what each can do.
 *
 * Shopify has no disconnect button in V1: disconnecting means uninstalling
 * from the Shopify admin, and the screen says so rather than offering a
 * control that would only fail. Search Console is the opposite — connect,
 * reconnect and disconnect all live here, because losing it only narrows what
 * the product knows rather than stopping it.
 */

export interface ConnectionsSettingsProps {
  readonly account: SettingsAccountView
  readonly t?: Translate
  readonly gscOutcome?: 'granted' | 'denied' | 'failed' | null
  readonly gscStartEndpoint?: string
  readonly gscDisconnectEndpoint?: string
  readonly shopifyStartEndpoint?: string
  /** Called once a property has been chosen, so the page can re-read the account. */
  readonly onGscSettled?: () => void
}

const SHOPIFY_STATUS_KEY: Readonly<Record<SettingsAccountView['connections']['shopify'], StringKey>> = {
  none: 'settings.connections.shopify.none',
  read: 'settings.connections.shopify.readOnly',
  read_write: 'settings.connections.shopify.readWrite',
  broken: 'settings.connections.shopify.broken',
}

export function ConnectionsSettings({
  account,
  t = defaultTranslate,
  gscOutcome = null,
  gscStartEndpoint = '/api/gsc/oauth/start',
  gscDisconnectEndpoint,
  shopifyStartEndpoint = '/api/shopify/oauth/start',
  onGscSettled,
}: ConnectionsSettingsProps) {
  const [busy, setBusy] = useState(false)
  const [disconnected, setDisconnected] = useState(false)

  async function reconnectShopify() {
    setBusy(true)
    try {
      const response = await fetch(shopifyStartEndpoint, { method: 'POST' })
      if (!response.ok) throw new Error('start failed')
      const body = (await response.json()) as { url?: string }
      if (!body.url) throw new Error('no redirect')
      window.location.assign(body.url)
    } catch {
      setBusy(false)
    }
  }

  async function connectOrReconnectGsc() {
    setBusy(true)
    try {
      // Which screen to come back to. The flow starts from here and from the
      // dashboard's onboarding card, and the picker below only appears on the
      // screen the merchant actually returns to.
      const response = await fetch(gscStartEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ returnTo: 'connections' }),
      })
      if (!response.ok) throw new Error('start failed')
      const body = (await response.json()) as { url?: string }
      if (!body.url) throw new Error('no redirect')
      window.location.assign(body.url)
    } catch {
      setBusy(false)
    }
  }

  async function disconnectGsc() {
    if (!gscDisconnectEndpoint) return
    setBusy(true)
    try {
      const response = await fetch(gscDisconnectEndpoint, { method: 'POST' })
      if (response.ok) setDisconnected(true)
    } finally {
      setBusy(false)
    }
  }

  const gscConnected = account.connections.searchConsole === 'connected' && !disconnected

  return (
    <section className="sortiva-settings__panel" data-settings-section="connections">
      <h1>{t('settings.connections.heading')}</h1>

      <div className="sortiva-settings__row" data-setting="shopify_connection">
        <div>
          <h2>{t('settings.connections.shopify.heading')}</h2>
          <p className="sortiva-settings__note">{t(SHOPIFY_STATUS_KEY[account.connections.shopify])}</p>
          {account.domain ? (
            <p className="sortiva-settings__note">
              {t('settings.connections.shopify.store', { domain: account.domain.normalized })}
            </p>
          ) : null}
          {account.connections.shopify === 'read' ? (
            <p className="sortiva-settings__note">{t('appendixA.shopifyReadOnlyTrust')}</p>
          ) : null}
        </div>
        {account.connections.shopify === 'broken' ? (
          <button type="button" disabled={busy} onClick={() => void reconnectShopify()}>
            {t('settings.connections.shopify.reconnect')}
          </button>
        ) : (
          <p className="sortiva-settings__note">{t('settings.connections.shopify.noDisconnect')}</p>
        )}
      </div>

      <div className="sortiva-settings__row" data-setting="gsc_connection">
        <div>
          <h2>{t('settings.connections.gsc.heading')}</h2>
          {gscOutcome === 'granted' ? (
            <p className="sortiva-settings__saved" role="status">
              {t('settings.connections.gsc.granted')}
            </p>
          ) : null}
          {/*
            Granting access is not connecting. Until this picker was mounted
            here, a merchant who connected from this screen was told
            "connected", was never asked which site is theirs, and stayed on
            limited data with nothing on screen to act on. It is the same
            component the dashboard uses, so both routes into the connection
            ask the same question and start the same import (main §6.7).
          */}
          {gscOutcome === 'granted' ? (
            <SearchConsoleStep initialPhase="picker" returnTo="connections" t={t} onSettled={onGscSettled} />
          ) : null}
          {gscOutcome === 'denied' ? (
            <p className="sortiva-settings__note" role="status">
              {t('settings.connections.gsc.denied')}
            </p>
          ) : null}
          {gscOutcome === 'failed' ? (
            <p className="sortiva-settings__error" role="alert">
              {t('settings.connections.gsc.failed')}
            </p>
          ) : null}

          {gscConnected ? null : (
            <LimitedIntelligenceBadge t={t} compact connectHref="#" />
          )}
        </div>

        {gscConnected ? (
          <div className="sortiva-settings__button-row">
            <button type="button" disabled={busy} onClick={() => void connectOrReconnectGsc()}>
              {t('settings.connections.gsc.reconnect')}
            </button>
            {gscDisconnectEndpoint ? (
              <button type="button" disabled={busy} onClick={() => void disconnectGsc()}>
                {t('settings.connections.gsc.disconnect')}
              </button>
            ) : null}
          </div>
        ) : (
          <button type="button" disabled={busy} onClick={() => void connectOrReconnectGsc()}>
            {t('settings.connections.gsc.connect')}
          </button>
        )}
      </div>
    </section>
  )
}
