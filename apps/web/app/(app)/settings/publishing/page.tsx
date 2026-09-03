import { PublishingSettings, type AccountSettingsData } from '@sortiva/ui'
import '@sortiva/ui/styles/settings.css'
import { getJson, requestContext } from '../../_lib/api'
import { SettingsNav } from '../_lib/nav'

/**
 * Settings → Publishing (ui §9.1).
 *
 * The timezone picker's pre-filled zone comes from the store's own country, so
 * this reads the store profile alongside settings rather than only settings.
 */

export const dynamic = 'force-dynamic'

const EMPTY: AccountSettingsData = {
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

export default async function PublishingSettingsPage() {
  const request = await requestContext()
  const [settings, profile] = await Promise.all([
    getJson<AccountSettingsData>('/api/settings', request),
    getJson<{ country: string | null }>('/api/profile', request),
  ])

  return (
    <div className="sortiva-settings">
      <SettingsNav current="publishing" />
      <PublishingSettings settings={settings ?? EMPTY} country={profile?.country ?? null} />
    </div>
  )
}
