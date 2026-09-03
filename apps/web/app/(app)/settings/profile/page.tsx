import { StoreProfileSettings, type ProfileDraft } from '@sortiva/ui'
import '@sortiva/ui/styles/onboarding.css'
import '@sortiva/ui/styles/settings.css'
import { getJson, requestContext } from '../../_lib/api'
import { SettingsNav } from '../_lib/nav'

/**
 * Settings → Store profile (ui §9.2): the confirmation screen, permanently
 * editable. The onboarding stylesheet is loaded alongside this screen's own
 * because the reused sections (keywords, competitors, families) are the
 * confirmation screen's own components.
 */

export const dynamic = 'force-dynamic'

const EMPTY: ProfileDraft = {
  description: '',
  language: '',
  country: '',
  audience: '',
  tone: '',
  topProducts: [],
  keywords: [],
  competitors: [],
  competitorSuggestions: [],
  families: [],
  richness: { band: 'sparse', productsMissingDetails: 0 },
  searchConsole: { connected: false, property: null },
  confirmed: false,
}

export default async function StoreProfileSettingsPage() {
  const profile = await getJson<ProfileDraft>('/api/profile', await requestContext())

  return (
    <div className="sortiva-settings">
      <SettingsNav current="profile" />
      <StoreProfileSettings profile={profile ?? EMPTY} />
    </div>
  )
}
