import { accountAttribution, type PosthogCapture } from '../contracts/analytics'
import type { GscProvider, GscTokens } from '../contracts/gsc'
import { annotateProperties, propertyMatchesClaimedDomain, type GscPropertyChoice } from './property'

/**
 * Connecting a store's Search Console, from the merchant's side.
 *
 * Four moments, and the rules that hold across them:
 *
 * - **It is optional and stays optional.** Skipping is a first-class outcome
 *   recorded on the onboarding step, not a failure, and it never blocks the rest
 *   of onboarding. What the merchant loses by skipping is stated on the screen,
 *   never hidden and never punished.
 * - **The property must be this store's.** A Google account can read properties
 *   for sites the merchant works on for other people. Choosing one of those is
 *   refused outright rather than warned about, because everything the engine
 *   later concludes would be about the wrong website with nothing to reveal it.
 * - **The history import starts here.** Choosing a property queues sixteen
 *   months of search data. If it is still arriving when the merchant confirms
 *   their profile, the opportunity run works with what has landed and re-scores
 *   when the rest does.
 *
 * The database, Google and analytics all arrive as ports, so this reads as the
 * sequence of decisions rather than as plumbing.
 */

/** One store's Search Console row, as this module needs to see it. */
export interface GscConnectionRecord {
  readonly property: string
  readonly tokens: string
  readonly invalidatedAt: Date | null
}

export interface GscConnectStore {
  /** The registrable domain this account claimed, or null if it has not claimed one. */
  claimedDomain(accountId: string): Promise<string | null>
  connection(accountId: string): Promise<GscConnectionRecord | null>
  saveGrant(accountId: string, tokens: string): Promise<void>
  /** Returns false when the grant vanished under us — another tab disconnected. */
  selectProperty(accountId: string, property: string, connectedAt: Date): Promise<boolean>
  /** Moves the onboarding step to succeeded. A run that has moved on simply does nothing. */
  completeConnectStep(accountId: string): Promise<void>
  /** Moves the onboarding step to skipped — the durable record that the merchant said no. */
  skipConnectStep(accountId: string): Promise<void>
  /** Queues the one-time history import. */
  enqueueBackfill(accountId: string): Promise<void>
}

/** Encrypt and decrypt at rest, so a database dump alone yields no usable token. */
export interface GscTokenCodec {
  encrypt(plaintext: string): string
  decrypt(stored: string): string
}

export interface GscConnectDeps {
  readonly store: GscConnectStore
  readonly provider: GscProvider
  readonly codec: GscTokenCodec
  readonly capture?: Pick<PosthogCapture, 'capture'>
  readonly now?: () => Date
}

/** One step of the activation funnel, fired when a property is actually chosen. */
export const GSC_CONNECTED_EVENT = 'gsc_connected'

interface StoredTokens {
  accessToken: string
  refreshToken: string | null
  expiresAt: string
  scope: string
}

export function encodeGscTokens(codec: GscTokenCodec, tokens: GscTokens): string {
  const stored: StoredTokens = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt.toISOString(),
    scope: tokens.scope,
  }
  return codec.encrypt(JSON.stringify(stored))
}

export function decodeGscTokens(codec: GscTokenCodec, stored: string): GscTokens {
  const raw = JSON.parse(codec.decrypt(stored)) as StoredTokens
  return {
    accessToken: raw.accessToken,
    refreshToken: raw.refreshToken,
    expiresAt: new Date(raw.expiresAt),
    scope: raw.scope,
  }
}

/** Where to send the merchant's browser. */
export function startGscConnect(
  deps: GscConnectDeps,
  input: { state: string; redirectUri: string },
): { redirectUrl: string } {
  return { redirectUrl: deps.provider.authorizationUrl(input) }
}

/**
 * Google has sent the merchant back with a one-time code. Trading it for tokens
 * records the *grant* — access we hold — which is not yet a connection: the
 * merchant has still to say which of their properties this store is.
 */
export async function completeGscGrant(
  deps: GscConnectDeps,
  input: { accountId: string; code: string; redirectUri: string },
): Promise<{ kind: 'granted' }> {
  const tokens = await deps.provider.exchangeCode({
    code: input.code,
    redirectUri: input.redirectUri,
  })
  await deps.store.saveGrant(input.accountId, encodeGscTokens(deps.codec, tokens))
  return { kind: 'granted' }
}

export type GscPropertiesResult =
  | { kind: 'properties'; properties: GscPropertyChoice[] }
  /** No grant yet, so there is nothing to list. */
  | { kind: 'not_granted' }
  | { kind: 'no_domain' }

/**
 * The picker's contents. Every property is returned, matching or not, each
 * flagged — so the screen can say *why* one cannot be chosen instead of leaving
 * the merchant to discover it after submitting.
 */
export async function listGscProperties(
  deps: GscConnectDeps,
  input: { accountId: string },
): Promise<GscPropertiesResult> {
  const [conn, domain] = await Promise.all([
    deps.store.connection(input.accountId),
    deps.store.claimedDomain(input.accountId),
  ])
  if (!conn) return { kind: 'not_granted' }
  if (!domain) return { kind: 'no_domain' }

  const tokens = decodeGscTokens(deps.codec, conn.tokens)
  const sites = await deps.provider.listSites(tokens.accessToken)
  return { kind: 'properties', properties: annotateProperties(sites, domain) }
}

export type ChooseGscPropertyResult =
  | { kind: 'selected'; property: string }
  /** The property is somebody else's site. Refused, with the claimed domain so the message can say which store we mean. */
  | { kind: 'host_mismatch'; claimedDomain: string }
  | { kind: 'not_granted' }
  | { kind: 'no_domain' }

/**
 * The merchant picks the property. This is the moment the connection exists: the
 * property is written, the connection is dated for the performance chart, the
 * onboarding step finishes, and the history import is queued.
 */
export async function chooseGscProperty(
  deps: GscConnectDeps,
  input: { accountId: string; siteUrl: string },
): Promise<ChooseGscPropertyResult> {
  const now = deps.now ?? (() => new Date())
  const [conn, domain] = await Promise.all([
    deps.store.connection(input.accountId),
    deps.store.claimedDomain(input.accountId),
  ])
  if (!conn) return { kind: 'not_granted' }
  if (!domain) return { kind: 'no_domain' }

  if (!propertyMatchesClaimedDomain(input.siteUrl, domain)) {
    return { kind: 'host_mismatch', claimedDomain: domain }
  }

  const saved = await deps.store.selectProperty(input.accountId, input.siteUrl, now())
  if (!saved) return { kind: 'not_granted' }

  await deps.store.completeConnectStep(input.accountId)
  // Queued rather than run here: sixteen months of data is minutes of work, and
  // the merchant is waiting on a screen. Onboarding carries on without it.
  await deps.store.enqueueBackfill(input.accountId)

  deps.capture?.capture({
    event: GSC_CONNECTED_EVENT,
    attribution: accountAttribution(input.accountId, domain),
    // Which *kind* of property, never the property itself: analytics carries
    // ids and aggregates, never a merchant's own content or addresses.
    properties: { property_kind: input.siteUrl.startsWith('sc-domain:') ? 'domain' : 'url_prefix' },
  })

  return { kind: 'selected', property: input.siteUrl }
}

/**
 * The merchant would rather not connect. Recorded on the onboarding step, which
 * is the durable answer to "did they decline or have they simply not got to it
 * yet" — nothing else is written, because running without Search Console is
 * worked out from the absence of a connection rather than from a stored flag.
 */
export async function skipGscConnect(
  deps: GscConnectDeps,
  input: { accountId: string },
): Promise<{ kind: 'skipped' }> {
  await deps.store.skipConnectStep(input.accountId)
  return { kind: 'skipped' }
}
