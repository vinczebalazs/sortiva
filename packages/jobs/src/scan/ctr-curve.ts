import type { Logger } from '@sortiva/core'
import { brandTokens, fitCtrCurve } from '@sortiva/core'
import {
  accountScope,
  findGscConnForAccount,
  findDomainForAccount,
  findShopifyConnForAccount,
  gscCurveSamples,
  insertCtrCurve,
  type CtrCurveRow,
  type Db,
} from '@sortiva/db'
import { rules } from '@sortiva/rules'
import { toIsoDate } from '@sortiva/core'
import { runtimeLogger } from '../runtime/logging'

/**
 * Re-measuring how often this store's listings actually get clicked at each
 * Google position.
 *
 * It is what "ranking well but nobody clicks" is judged against. Comparing a
 * page to a published industry click-rate table would be close to meaningless:
 * the rate at any position swings with the device mix, with how much of the
 * traffic is people typing the brand name, and with whatever else Google puts on
 * the results page. So the comparison is against the store itself.
 *
 * Refit weekly rather than nightly because a store's click behaviour moves over
 * months, and because a curve that jumps every night would make the same page
 * flagged and unflagged on alternate days.
 */

export interface CtrCurveRefitDeps {
  readonly db: Db
  readonly now?: () => Date
  readonly logger?: Logger
}

export type CtrCurveRefitOutcome =
  | { readonly status: 'fitted'; readonly row: CtrCurveRow; readonly source: 'fitted' | 'standard' }
  /** No Search Console connection, or none chosen yet: there is nothing to fit from and nothing to fall back for. */
  | { readonly status: 'not_connected' }

/**
 * A store with no Search Console connection gets no row at all, rather than a
 * row holding the fallback table. A stored fallback would look like a
 * measurement of that store, and the reader cannot tell the difference; an
 * absent row is unambiguous, and the detector that reads it already has to
 * handle a store that has never been fitted.
 */
export async function refitCtrCurveForAccount(
  deps: CtrCurveRefitDeps,
  accountId: string,
): Promise<CtrCurveRefitOutcome> {
  const log = deps.logger ?? runtimeLogger()
  const now = (deps.now ?? (() => new Date()))()
  const scope = accountScope(accountId)

  const connection = await findGscConnForAccount(deps.db, scope)
  if (!connection || connection.property === '') return { status: 'not_connected' }

  const config = rules().defaults.ctr_curve
  const searchConsole = rules().defaults.search_console

  // Google keeps revising the last few days, so the window stops short of today
  // by the same lag every other Search Console window uses.
  const end = new Date(now)
  end.setUTCDate(end.getUTCDate() - searchConsole.data_lag_days)
  const start = new Date(end)
  start.setUTCDate(start.getUTCDate() - config.window_days + 1)

  const samples = await gscCurveSamples(deps.db, scope, {
    startDate: toIsoDate(start),
    endDate: toIsoDate(end),
  })

  const [domain, shopify] = await Promise.all([
    findDomainForAccount(deps.db, scope),
    findShopifyConnForAccount(deps.db, scope),
  ])

  const tokens = brandTokens({
    domainNormalized: domain?.domainNormalized ?? null,
    shopHandle: shopify?.shopHandle ?? null,
  })

  const fit = fitCtrCurve({
    rows: samples.map((sample) => ({
      query: sample.query,
      position: sample.position,
      clicks: sample.clicks,
      impressions: sample.impressions,
    })),
    config,
    brandTokens: tokens,
  })

  const row = await insertCtrCurve(deps.db, scope, {
    curveJson: fit.curve,
    sampleN: fit.sampleN,
    brandedExcluded: fit.brandedExcluded,
    fittedAt: now,
  })

  log.info('ctr_curve_fitted', {
    account_id: accountId,
    source: fit.source,
    sample_n: fit.sampleN,
    branded_excluded: fit.brandedExcluded,
    ...(fit.fallbackReason ? { fallback_reason: fit.fallbackReason } : {}),
  })

  return { status: 'fitted', row, source: fit.source }
}
