import type { IngestionStatus, ShellAccount } from '@sortiva/ui'
import { getJson, requestContext, type JsonLoader, type RequestContext } from './api'

/**
 * What the dashboard needs before it can decide which stage of setting up a
 * store it is showing.
 *
 * The account says where the domain has got to. The run says which step is
 * moving, and is only worth asking for while a run exists — a store that is
 * already confirmed has nothing to follow.
 */

export interface OnboardingData {
  readonly account: ShellAccount
  readonly status: IngestionStatus | null
}

/** An account we could not read locks everything and shows the first step. */
export const UNKNOWN: ShellAccount = {
  domain: null,
  subscription: { status: 'none' },
  limitedIntelligence: false,
  connections: { shopify: 'none', searchConsole: 'none', lastScanAt: null },
  servicePaused: false,
}

/** The domain states during which a setup run exists to be followed. */
const RUNNING_STATES = new Set(['ingesting', 'awaiting_shopify_auth', 'needs_confirmation'])

/** The testable half: everything but reading the incoming request's headers. */
export async function buildOnboardingData(
  request: RequestContext,
  load: JsonLoader = getJson,
): Promise<OnboardingData> {
  const account = (await load<ShellAccount>('/api/account', request)) ?? UNKNOWN
  const state = account.domain?.state ?? 'none'

  const status = RUNNING_STATES.has(state)
    ? await load<IngestionStatus>('/api/ingestion/status', request)
    : null

  return { account, status }
}

export async function loadOnboardingData(): Promise<OnboardingData> {
  return buildOnboardingData(await requestContext())
}
