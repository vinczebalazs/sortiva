import { ConnectionsSettings, type SettingsAccountView } from '@sortiva/ui'
import '@sortiva/ui/styles/settings.css'
import { getJson, requestContext } from '../../_lib/api'
import { SettingsNav } from '../_lib/nav'

/**
 * Settings → Connections (ui §9.3).
 *
 * This is also the fixed return address Google sends a merchant back to after
 * the Search Console consent screen (`apps/web/app/api/gsc/_lib/config.ts`'s
 * `GSC_RETURN_PATH`), with the outcome in `?gsc=`. The path is not this
 * screen's to choose — it is already load-bearing elsewhere.
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
