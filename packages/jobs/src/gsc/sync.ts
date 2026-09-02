import {
  GscGrantRevoked,
  toPageDailyRows,
  toQueryDailyRows,
  type DateRange,
  type GscProvider,
  type GscSearchAnalyticsRow,
  type GscTokens,
  type Logger,
} from '@sortiva/core'
import {
  accountScope,
  findGscConnForAccount,
  markGscGrantInvalid,
  saveGscGrant,
  upsertGscDaily,
  upsertGscQueryDaily,
  type Db,
} from '@sortiva/db'
import { runtimeLogger } from '../runtime/logging'

/**
 * Fetching one window of a store's search data and writing it down.
 *
 * Both the one-time import and the nightly sync are this function with
 * different windows, which is the point: one place decides how a dead grant is
 * handled, how the access token is renewed, and how Google's report becomes our
 * two tables.
 *
 * The rule this function exists to keep: **when the grant dies, reporting stops
 * and nothing else does.** It records that the connection needs re-making and
 * returns; it does not fail the step, does not retry, and does not touch
 * anything the content pipeline depends on. A merchant whose Google grant
 * lapsed still gets articles.
 */

/** Encrypt and decrypt at rest. Satisfied by the real cipher; a test passes a plain one. */
export interface TokenCodec {
  encrypt(plaintext: string): string
  decrypt(stored: string): string
}

export interface GscSyncDeps {
  readonly db: Db
  readonly provider: GscProvider
  readonly codec: TokenCodec
  readonly now?: () => Date
  readonly logger?: Logger
}

export type GscSyncOutcome =
  | { readonly status: 'synced'; readonly rowsWritten: number; readonly pages: number }
  /** Nothing to do: no connection, or no property chosen yet. */
  | { readonly status: 'not_connected' }
  /** The grant is gone. Recorded, and the merchant is asked to reconnect; the pipeline is untouched. */
  | { readonly status: 'grant_invalid' }

/**
 * How long before expiry we renew rather than risk it. A token that expires
 * mid-import turns a working sync into a reconnect prompt for no reason.
 */
const RENEW_MARGIN_MS = 5 * 60 * 1000

/** Guards against a vendor that keeps claiming there is one more page. */
const MAX_PAGES_PER_RANGE = 200

interface StoredTokens {
  accessToken: string
  refreshToken: string | null
  expiresAt: string
  scope: string
}

export async function syncSearchConsoleRange(
  deps: GscSyncDeps,
  accountId: string,
  range: DateRange,
  options: { signal?: AbortSignal } = {},
): Promise<GscSyncOutcome> {
  const now = deps.now ?? (() => new Date())
  const log = deps.logger ?? runtimeLogger()
  const scope = accountScope(accountId)

  const conn = await findGscConnForAccount(deps.db, scope)
  if (!conn || conn.property === '' || conn.invalidatedAt) return { status: 'not_connected' }

  let tokens: GscTokens
  try {
    tokens = await usableAccessToken(deps, accountId, conn.tokens, now())
  } catch (error) {
    if (error instanceof GscGrantRevoked) {
      await recordDeadGrant(deps, accountId, now(), log)
      return { status: 'grant_invalid' }
    }
    throw error
  }

  const collected: GscSearchAnalyticsRow[] = []
  let startRow = 0
  let pages = 0

  while (pages < MAX_PAGES_PER_RANGE) {
    if (options.signal?.aborted) break
    let page
    try {
      page = await deps.provider.searchAnalytics(tokens.accessToken, {
        siteUrl: conn.property,
        startDate: range.startDate,
        endDate: range.endDate,
        startRow,
      })
    } catch (error) {
      if (error instanceof GscGrantRevoked) {
        await recordDeadGrant(deps, accountId, now(), log)
        return { status: 'grant_invalid' }
      }
      throw error
    }
    pages += 1
    collected.push(...page.rows)
    if (!page.hasMore || page.nextStartRow === startRow) break
    startRow = page.nextStartRow
  }

  const queryRows = toQueryDailyRows(collected)
  const pageRows = toPageDailyRows(queryRows)
  const written = await upsertGscQueryDaily(deps.db, scope, queryRows)
  await upsertGscDaily(deps.db, scope, pageRows)

  return { status: 'synced', rowsWritten: written, pages }
}

/**
 * Returns a token good for the whole of this window, renewing it first if it is
 * close to expiry. A renewal that succeeds is stored immediately, so the next
 * job does not renew again; Google sometimes withholds a new refresh token on a
 * renewal, and dropping the old one in that case would end the connection.
 */
async function usableAccessToken(
  deps: GscSyncDeps,
  accountId: string,
  stored: string,
  now: Date,
): Promise<GscTokens> {
  const current = parseTokens(deps.codec.decrypt(stored))
  if (current.expiresAt.getTime() - now.getTime() > RENEW_MARGIN_MS) return current

  if (!current.refreshToken) {
    // Nothing to renew with. Treated as a dead grant rather than as an error,
    // because the merchant's only route out of it is to reconnect.
    throw new GscGrantRevoked('the stored Search Console grant cannot be renewed')
  }

  const renewed = await deps.provider.refresh(current.refreshToken)
  const tokens: GscTokens = {
    ...renewed,
    refreshToken: renewed.refreshToken ?? current.refreshToken,
  }
  await saveGscGrant(deps.db, accountScope(accountId), { tokens: encodeTokens(deps.codec, tokens) })
  return tokens
}

async function recordDeadGrant(
  deps: GscSyncDeps,
  accountId: string,
  at: Date,
  log: Logger,
): Promise<void> {
  const row = await markGscGrantInvalid(deps.db, accountScope(accountId), at)
  // Only the first discovery updates a row, so this logs once rather than on
  // every retry — which is also what will make the reconnect email land once.
  if (row) log.info('gsc_grant_invalidated', { account_id: accountId })
}

export function encodeTokens(codec: TokenCodec, tokens: GscTokens): string {
  const stored: StoredTokens = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt.toISOString(),
    scope: tokens.scope,
  }
  return codec.encrypt(JSON.stringify(stored))
}

function parseTokens(plaintext: string): GscTokens {
  const raw = JSON.parse(plaintext) as StoredTokens
  return {
    accessToken: raw.accessToken,
    refreshToken: raw.refreshToken,
    expiresAt: new Date(raw.expiresAt),
    scope: raw.scope,
  }
}
