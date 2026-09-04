import type pg from 'pg'
import {
  accountAttribution,
  pickInFamilyEquivalent,
  planRepair,
  rankByImpact,
  routeWritesToShop,
  type DriftObservation,
  type Logger,
  type NotificationEmitter,
  type PosthogCapture,
  type RepairRouting,
  type SubstituteCandidate,
} from '@sortiva/core'
import { rules } from '@sortiva/rules'
import {
  accountScope,
  deletedShopifyProductIds,
  familyAxes,
  familyMembersWithFacts,
  insertOpportunityTasks,
  lastAvailabilityChangeAt,
  publishedArticleProductRefs,
  readRepairSettings,
  systemScope,
  upsertOpportunity,
  type Db,
  type ReferencedProductRow,
} from '@sortiva/db'
import { detectDrift, anyVariantAvailable } from './detect'
import { applyMechanicalRepair, type RepairExecutionDeps } from './repair'
import { withAccountLock } from '../runtime/lock'
import { runtimeLogger } from '../runtime/logging'

/**
 * The daily pass that asks, for one store, whether anything it published is
 * still true.
 *
 * The catalogue is alive and a published article is not. Nothing in the product
 * notices on its own that a merchant withdrew the product a guide recommends —
 * the guide goes on recommending it, and a page that ranks well while being
 * wrong is worse than no page at all. This is the thing that notices.
 *
 * It re-reads current state every time rather than following a running tally of
 * changes. That is deliberate and it is what makes the pass safe to run twice,
 * to miss a day, or to be killed halfway: the answer depends only on how the
 * store is right now, so a pass that never ran costs a day of lateness and
 * nothing else. The one thing current state cannot tell us is that a product
 * was *deleted* — nothing removes the local row — so that one fact is read from
 * the shared record of what the store told us changed.
 */

/** How far back the pass looks for deletions the store reported. */
const DELETION_LOOKBACK_DAYS = 30

export interface DriftSweepDeps extends RepairExecutionDeps {
  readonly db: Db
  readonly pool: pg.Pool
  readonly notifications?: NotificationEmitter
  readonly capture?: Pick<PosthogCapture, 'capture'>
  readonly now?: () => Date
  readonly logger?: Logger
}

/** Main §14.7's observability: one event per pass, ids and counts only. */
export const DRIFT_PASS_EVENT = 'drift_pass_completed'

export interface DriftPassResult {
  /** Published articles whose product mentions were examined. */
  readonly articlesChecked: number
  /** Things found wrong, one per article per kind. */
  readonly driftFound: number
  /** Repairs we made and put back on the merchant's shop ourselves. */
  readonly repairedAutomatically: number
  /** Repairs the merchant was handed as a card. */
  readonly cardsRaised: number
  /** Articles queued to be rewritten through the normal pipeline. */
  readonly rewritesQueued: number
}

const EMPTY: DriftPassResult = {
  articlesChecked: 0,
  driftFound: 0,
  repairedAutomatically: 0,
  cardsRaised: 0,
  rewritesQueued: 0,
}

export async function runDriftPassForAccount(
  deps: DriftSweepDeps,
  input: { readonly accountId: string },
): Promise<DriftPassResult> {
  // Serialised with everything else this account has running. A repair
  // republishes an article, and a publish-hour run publishing the same article
  // at the same moment is exactly the race the lock exists for.
  return withAccountLock(deps.pool, input.accountId, () => driftPass(deps, input.accountId))
}

async function driftPass(deps: DriftSweepDeps, accountId: string): Promise<DriftPassResult> {
  const log = deps.logger ?? runtimeLogger()
  const now = (deps.now ?? (() => new Date()))()
  const scope = accountScope(accountId)
  const config = rules()
  const signals = config.defaults.signals

  const references = await publishedArticleProductRefs(deps.db, scope)
  const articleIds = new Set(references.map((row) => row.articleId))
  if (references.length === 0) return EMPTY

  const shopifyIds = references
    .map((row) => row.shopifyProductId)
    .filter((id): id is string => id !== null)

  const [deleted, stockMovedAt] = await Promise.all([
    deletedShopifyProductIds(
      deps.db,
      systemScope('the change record has no account column; the account travels in the payload'),
      accountId,
      new Date(now.getTime() - DELETION_LOOKBACK_DAYS * 86_400_000),
    ),
    lastAvailabilityChangeAt(
      deps.db,
      systemScope('the change record has no account column; the account travels in the payload'),
      accountId,
      shopifyIds,
    ),
  ])

  const familyIds = [
    ...new Set(references.map((row) => row.familyId).filter((id): id is string => id !== null)),
  ]
  const axes = await familyAxes(deps.db, scope, familyIds)

  const observations = detectDrift({
    accountId,
    references,
    deletedShopifyIds: new Set(deleted),
    stockMovedAt,
    familyAxes: axes,
    outOfStockDaysMin: signals.product_change_impact.out_of_stock_days_min,
    now,
  })

  if (observations.length === 0) {
    log.info('drift_pass_complete', { account_id: accountId, articles: articleIds.size, drift: 0 })
    return { ...EMPTY, articlesChecked: articleIds.size }
  }

  const settings = await readRepairSettings(deps.db, scope)
  const members = await familyMembersWithFacts(deps.db, scope, familyIds)
  const candidates: SubstituteCandidate[] = members
    .filter((member) => !isGone(member.productId, references, deleted))
    .map((member) => ({
      productId: member.productId,
      title: member.title,
      familyId: member.familyId,
      available: anyVariantAvailable(member.variants),
      factKeys: member.factKeys,
    }))

  const planned = observations.map((observation) => {
    const swaps = plannedSwaps(observation, references, candidates, members, signals.broken_product_reference.substitute_fact_overlap_min)
    const plan = planRepair(
      observation,
      {
        delivery: settings.delivery,
        autoRepair: settings.autoRepair,
        substituteAvailable: swaps.length > 0 && swaps.length === observation.references.length,
      },
      {
        rulesVersion: config.rulesVersion,
        detectedAt: now.toISOString(),
        limitedIntelligence: false,
      },
      config.defaults.scoring,
    )
    return { observation, swaps, ...plan }
  })

  const ranked = rankByImpact(
    planned.map((entry) => entry.draft),
    config.defaults.scoring.impact,
  )

  let repairedAutomatically = 0
  let cardsRaised = 0
  let rewritesQueued = 0

  for (const [index, entry] of planned.entries()) {
    const draft = ranked[index]!
    const { row, created } = await upsertOpportunity(deps.db, scope, draft, now)
    if (created) await insertOpportunityTasks(deps.db, row.id, draft.tasks)

    if (entry.routing.route === 'gate3_refresh') {
      rewritesQueued += 1
      await tellTheMerchant(deps, accountId, entry.observation, entry.routing, log)
      continue
    }

    if (routeWritesToShop(entry.routing.route)) {
      const repaired = await applyMechanicalRepair(deps, {
        accountId,
        opportunityId: row.id,
        articleId: entry.observation.articleId,
        kind: entry.observation.kind,
        route: entry.routing.route,
        swaps: entry.swaps,
        now,
      })
      if (repaired.status === 'repaired') repairedAutomatically += 1
      else cardsRaised += 1
      await tellTheMerchant(deps, accountId, entry.observation, entry.routing, log)
      continue
    }

    // A card. Our own copy is still mended, so the download the card offers is
    // genuinely the repaired article — what the merchant is spared is an edit
    // to their own site, not the repair.
    await applyMechanicalRepair(deps, {
      accountId,
      opportunityId: row.id,
      articleId: entry.observation.articleId,
      kind: entry.observation.kind,
      route: entry.routing.route,
      swaps: entry.swaps,
      now,
    })
    cardsRaised += 1
    await tellTheMerchant(deps, accountId, entry.observation, entry.routing, log)
  }

  const result: DriftPassResult = {
    articlesChecked: articleIds.size,
    driftFound: observations.length,
    repairedAutomatically,
    cardsRaised,
    rewritesQueued,
  }

  deps.capture?.capture({
    event: DRIFT_PASS_EVENT,
    attribution: accountAttribution(accountId),
    properties: { ...result },
  })
  log.info('drift_pass_complete', { account_id: accountId, ...result })
  return result
}

function isGone(
  productId: string,
  references: readonly ReferencedProductRow[],
  deleted: readonly string[],
): boolean {
  const shopifyId = references.find((row) => row.productId === productId)?.shopifyProductId
  return shopifyId !== undefined && shopifyId !== null && deleted.includes(shopifyId)
}

export interface PlannedSwap {
  readonly refId: string
  readonly placeholderKey: string
  readonly fromProductId: string
  readonly fromProductTitle: string
  readonly toProductId: string
  readonly toProductTitle: string
  readonly overlap: number
}

/**
 * What the mechanical repair would actually do, worked out before anything is
 * written down.
 *
 * A repair is only mechanical when *every* broken mention has a stand-in. One
 * unswappable mention out of three still leaves a sentence naming something the
 * store does not sell, so the whole article goes to the rewriting queue rather
 * than being two-thirds mended and published as if it were finished.
 */
function plannedSwaps(
  observation: DriftObservation,
  references: readonly ReferencedProductRow[],
  candidates: readonly SubstituteCandidate[],
  members: readonly { readonly productId: string; readonly factKeys: readonly string[] }[],
  overlapMin: number,
): readonly PlannedSwap[] {
  if (observation.kind !== 'product_deleted') return []

  const swaps: PlannedSwap[] = []
  for (const reference of observation.references) {
    const row = references.find(
      (candidate) =>
        candidate.articleId === observation.articleId &&
        candidate.placeholderKey === reference.placeholderKey,
    )
    if (!row?.productId) continue
    const facts = members.find((member) => member.productId === row.productId)?.factKeys ?? []
    const choice = pickInFamilyEquivalent(
      { productId: row.productId, familyId: row.familyId, factKeys: facts },
      candidates,
      overlapMin,
    )
    if (!choice) continue
    swaps.push({
      refId: row.refId,
      placeholderKey: row.placeholderKey,
      fromProductId: row.productId,
      fromProductTitle: row.productTitle ?? row.placeholderKey,
      toProductId: choice.productId,
      toProductTitle: choice.title,
      overlap: choice.overlap,
    })
  }
  return swaps
}

/**
 * One line in the bell, deduplicated on the article and what went wrong.
 *
 * A page on somebody's site that has stopped being true is worth telling them
 * about whichever way it is being fixed — including when we are fixing it
 * ourselves, because it is their site and their name on it.
 */
async function tellTheMerchant(
  deps: DriftSweepDeps,
  accountId: string,
  observation: DriftObservation,
  routing: RepairRouting,
  log: Logger,
): Promise<void> {
  await deps.notifications
    ?.emit(
      'repair_needed',
      { article_id: observation.articleId, reason: observation.kind, route: routing.route },
      `${observation.articleId}:${observation.kind}`,
      accountAttribution(accountId),
    )
    .catch((error: unknown) => {
      log.warn('drift_notification_failed', {
        account_id: accountId,
        article_id: observation.articleId,
        error: String(error),
      })
      return { created: false }
    })
}

export { EMPTY as EMPTY_DRIFT_PASS }
