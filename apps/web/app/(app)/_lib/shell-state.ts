import type { ShellAccount } from '@sortiva/ui'
import { getJson, requestContext, type JsonLoader, type RequestContext } from './api'

/**
 * The two responses the app frame needs before it can render anything.
 *
 * Both are fetched over our own API rather than read from the database
 * directly, so the frame runs unchanged against the mock server the screens are
 * built on and against the real endpoints as they land.
 */

export interface ShellSettings {
  readonly vacationMode: boolean
  readonly uiLanguage: string | null
}

export interface ShellState {
  readonly account: ShellAccount
  readonly settings: ShellSettings | null
  /** The browser's language ordering, for choosing the interface language. */
  readonly acceptLanguage: readonly string[]
}

/**
 * What the frame assumes when it could not find out. Everything locked and no
 * notices: a merchant briefly seeing fewer destinations than they have is
 * recoverable, whereas an unlocked screen that then fails to load is not, and a
 * "payment failed" banner raised by a failed fetch would be a lie.
 */
export const UNKNOWN_ACCOUNT: ShellAccount = {
  domain: null,
  subscription: { status: 'none' },
  limitedIntelligence: false,
  connections: { shopify: 'none', searchConsole: 'none', lastScanAt: null },
  servicePaused: false,
}

export function parseAcceptLanguage(header: string | null): readonly string[] {
  if (!header) return []
  return header
    .split(',')
    .map((part) => part.split(';')[0]?.trim() ?? '')
    .filter((tag) => tag.length > 0 && tag !== '*')
}

export type ShellRequest = RequestContext

/**
 * The testable half: everything but reading the incoming request's headers.
 *
 * The loader degrades to null rather than throwing, which is what a frame
 * needs: one that dies takes every screen with it, and Settings in particular
 * is still a mock, so a missing endpoint has to be survivable.
 */
export async function buildShellState(
  request: ShellRequest,
  load: JsonLoader = getJson,
): Promise<ShellState> {
  const [account, settings] = await Promise.all([
    load<ShellAccount>('/api/account', request),
    load<ShellSettings>('/api/settings', request),
  ])

  return {
    account: account ?? UNKNOWN_ACCOUNT,
    settings,
    acceptLanguage: parseAcceptLanguage(request.acceptLanguage),
  }
}

export async function loadShellState(): Promise<ShellState> {
  return buildShellState(await requestContext())
}
