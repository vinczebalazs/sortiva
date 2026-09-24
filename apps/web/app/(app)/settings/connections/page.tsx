import { ConnectionsSettings, type SettingsAccountView } from '@sortiva/ui'
import '@sortiva/ui/styles/settings.css'
import { getJson, requestContext } from '../../_lib/api'
import { SettingsNav } from '../_lib/nav'

/**
 * Settings → Connections (ui §9.3).
 *
 * One of the two screens Google can send a merchant back to after the Search
 * Console consent screen, with the outcome in `?gsc=`. Which one is decided by
 * where they started, carried in the signed OAuth state; this screen simply
 * renders what it was handed. When the answer is `granted`, the property picker
 * appears here — granting access is not the same as being connected, and until
 * it was mounted this screen said "connected" over a connection that had never
 * chosen a property.
 */

export const dynamic = 'force-dynamic'

const EMPTY: SettingsAccountView = {
  domain: null,
  subscription: { status: 'none', cancelAtPeriodEnd: false, currentPeriodEnd: null },
  limitedIntelligence: false,
  connections: { shopify: 'none', searchConsole: 'none', lastScanAt: null },
}

function gscOutcomeOf(value: string | string[] | undefined): 'granted' | 'denied' | 'failed' | null {
  const raw = Array.isArray(value) ? value[0] : value
  return raw === 'granted' || raw === 'denied' || raw === 'failed' ? raw : null
}

export default async function ConnectionsSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const account = await getJson<SettingsAccountView>('/api/account', await requestContext())
  const params = await searchParams

  return (
    <div className="sortiva-settings">
      <SettingsNav current="connections" />
      <ConnectionsSettings account={account ?? EMPTY} gscOutcome={gscOutcomeOf(params.gsc)} />
    </div>
  )
}
