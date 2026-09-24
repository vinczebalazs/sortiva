import { AccountSettings, type AccountSettingsData } from '@sortiva/ui'
import '@sortiva/ui/styles/settings.css'
import { getJson, requestContext } from '../../_lib/api'
import { SettingsNav } from '../_lib/nav'

/**
 * Settings → Account (ui §9.4): vacation mode, email preferences, UI language,
 * and account deletion.
 *
 * Billing is deliberately absent. There is no purchase layer to link to and
 * nothing a merchant can do about payment here, so the card that used to sit in
 * the middle of this screen would have been a control leading nowhere.
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

export default async function AccountSettingsPage() {
  const request = await requestContext()
  const settings = await getJson<AccountSettingsData>('/api/settings', request)

  return (
    <div className="sortiva-settings">
      <SettingsNav current="account" />
      <AccountSettings settings={settings ?? EMPTY_SETTINGS} />
    </div>
  )
}
