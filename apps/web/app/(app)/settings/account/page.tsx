import {
  AccountSettings,
  type AccountSettingsData,
  type SettingsAccountView,
  type SettingsPlanView,
} from '@sortiva/ui'
import '@sortiva/ui/styles/settings.css'
import { getJson, requestContext } from '../../_lib/api'
import { SettingsNav } from '../_lib/nav'

/**
 * Settings → Account (ui §9.4): vacation mode, billing, email preferences, UI
 * language, and account deletion.
 *
 * Also the fixed return address the Stripe Customer Portal sends a merchant
 * back to (`packages/core/src/billing/checkout.ts`'s `openBillingPortal`,
 * `?billing=returned`) — a fresh read of `GET /api/account` on the way back in
 * already shows whatever changed, so nothing further reads that parameter.
 */

export const dynamic = 'force-dynamic'

const EMPTY_SETTINGS: AccountSettingsData = {
  delivery: 'export',
  shopifyPublishAs: 'live',
  publishHour: 9,
  timezone: 'UTC',
  draftReview: false,
  autoRepair: true,
  vacationMode: false,
  uiLanguage: null,
  emailArticlePublished: false,
  emailDigestFrequency: 'off',
}

const EMPTY_ACCOUNT: SettingsAccountView = {
  domain: null,
  subscription: { status: 'none', cancelAtPeriodEnd: false, currentPeriodEnd: null },
  limitedIntelligence: false,
  connections: { shopify: 'none', searchConsole: 'none', lastScanAt: null },
}

const EMPTY_PLAN: SettingsPlanView = { capLine: '', inclusions: [], cancellationFacts: [] }

export default async function AccountSettingsPage() {
  const request = await requestContext()
  const [settings, account, plan] = await Promise.all([
    getJson<AccountSettingsData>('/api/settings', request),
    getJson<SettingsAccountView>('/api/account', request),
    getJson<SettingsPlanView>('/api/billing/plan', request),
  ])

  return (
    <div className="sortiva-settings">
      <SettingsNav current="account" />
      <AccountSettings
        settings={settings ?? EMPTY_SETTINGS}
        account={account ?? EMPTY_ACCOUNT}
        plan={plan ?? EMPTY_PLAN}
      />
    </div>
  )
}
