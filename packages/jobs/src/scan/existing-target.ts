import type {
  ClusterRankedPage,
  ExistingTargetCheck,
  ExistingTargetOutcome,
  ExistingTargetPage,
  ExistingTargetResult,
  Logger,
  ProxyRankedKeyword,
  QueryCluster,
  SeoDataProvider,
} from '@sortiva/core'
import {
  findExistingTarget,
  isLimitedIntelligence,
  normaliseQuery,
  toContractOutcome,
  toIsoDate,
} from '@sortiva/core'
import {
  accountScope,
  findDomainForAccount,
  findGscConnForAccount,
  gscPageQueryTotals,
  listStorePages,
  readPersona,
  type Db,
} from '@sortiva/db'
import { rules } from '@sortiva/rules'
import { runtimeLogger } from '../runtime/logging'

/**
 * The existing-target check as the running product calls it: the same rule,
 * with one store's real data gathered behind it.
 *
 * The rule itself lives in `@sortiva/core` and takes plain data, so what it
 * decides can be read off a table in a test. This file is the part that goes
 * and fetches: what Google showed for the intent, what the store publishes,
 * and — only for a store with no Search Console connection — what the search
 * vendor says the domain ranks for.
 */

export interface ExistingTargetDeps {
  readonly db: Db
  readonly seo: SeoDataProvider
  readonly now?: () => Date
  readonly logger?: Logger
}

/**
 * How many of the domain's own rankings to ask the vendor for in the no-Search
 * Console fallback.
 *
 * A cost lever rather than a rule about the product: one request returns up to
 * this many rows whatever we ask for, and the answer only has to contain the
 * intent we are checking. Deliberately not in `packages/rules`, which holds the
 * numbers that decide what the product believes, not how big a page of vendor
 * results is.
 */
const PROXY_RANKING_LIMIT = 500

function toRankedPages(
  rows: readonly { page: string; query: string; clicks: number; impressions: number; position: number | null }[],
  cluster: QueryCluster,
): ClusterRankedPage[] {
  const wanted = new Set([cluster.head, ...cluster.members].map(normaliseQuery).filter(Boolean))

  // Search Console reports one row per page and phrasing; the check reasons
  // about the intent, so the phrasings are pooled and position re-averaged over
  // impressions — a mean of means would weight a phrasing shown twice the same
  // as one shown ten thousand times.
  const perPage = new Map<string, { impressions: number; weighted: number; weightBase: number }>()
  for (const row of rows) {
    if (!wanted.has(normaliseQuery(row.query))) continue
    const acc = perPage.get(row.page) ?? { impressions: 0, weighted: 0, weightBase: 0 }
    acc.impressions += row.impressions
    if (row.position !== null && row.impressions) {
      acc.weighted += row.position * row.impressions
      acc.weightBase += row.impressions
    }
    perPage.set(row.page, acc)
  }

  return [...perPage.entries()].map(([page, acc]) => ({
    url: page,
    impressions: acc.impressions,
    position: acc.weightBase === 0 ? null : acc.weighted / acc.weightBase,
  }))
}

/**
 * Whether the store still publishes each address.
 *
 * The walk records this now: it stamps every page the store served it and, on
 * reaching the end of the store, marks whatever it did not find. So a merchant
 * who deletes a collection is finally visible here, and the check can stop
 * treating a page that no longer exists as a reason not to write a new one.
 *
 * A row is only ever `published` or `removed`, never `unknown` — but `unknown`
 * remains the type's safe middle, and the rule still reads it as published,
 * because treating a live page as gone is what produces two of our pages
 * competing for one search.
 */
function presenceOf(row: { status: 'live' | 'gone' }): ExistingTargetPage['presence'] {
  return row.status === 'gone' ? 'removed' : 'published'
}

export async function existingTargetInputFor(
  deps: ExistingTargetDeps,
  accountId: string,
  cluster: QueryCluster,
): Promise<Parameters<typeof findExistingTarget>[0]> {
  const scope = accountScope(accountId)
  const now = (deps.now ?? (() => new Date()))()
  const config = rules().defaults.gates.existing_target_check
  const searchConsole = rules().defaults.search_console

  const connection = await findGscConnForAccount(deps.db, scope)
  const limited = isLimitedIntelligence(connection ?? null)

  // Search Console publishes about two days late, so the window ends there
  // rather than today; treating "not reported yet" as "nobody searched" would
  // make a live page look unranked and clear the way for a competing one.
  const end = new Date(now)
  end.setUTCDate(end.getUTCDate() - searchConsole.data_lag_days)
  const start = new Date(end)
  start.setUTCDate(start.getUTCDate() - config.window_days + 1)

  // Every row, deleted ones included, and deliberately not `listLiveStorePages`.
  // The rule needs to *see* a removed page to rule it out: it reads presence off
  // the row, and a page missing from this list is one it holds no opinion about,
  // which it treats as still published. Filtering here would turn every deletion
  // back into a live page — the opposite of this card.
  const inventory = await listStorePages(deps.db, scope)
  const pages: ExistingTargetPage[] = inventory.map((row) => ({
    url: row.url,
    pageType: row.pageType,
    intentClass: row.intentClass,
    familyIds: row.familyIds,
    presence: presenceOf(row),
  }))

  const rankedPages = limited
    ? []
    : toRankedPages(
        await gscPageQueryTotals(
          deps.db,
          scope,
          { startDate: toIsoDate(start), endDate: toIsoDate(end) },
          rules().defaults.clusters.min_query_impressions,
        ),
        cluster,
      )

  return {
    cluster,
    rankedPages,
    pages,
    proxyRankings: limited ? await proxyRankings(deps, accountId) : [],
    limitedIntelligence: limited,
    config,
    fetchedAt: now.toISOString(),
  }
}

/**
 * The no-Search Console fallback: the vendor's account of what this domain
 * ranks for.
 *
 * A billable read, so it happens only for a store that has nothing better, and
 * the provider's own cache means the same domain asked twice in a month is
 * charged once.
 */
async function proxyRankings(
  deps: ExistingTargetDeps,
  accountId: string,
): Promise<ProxyRankedKeyword[]> {
  const scope = accountScope(accountId)
  const domain = await findDomainForAccount(deps.db, scope)
  const persona = await readPersona(deps.db, scope)
  if (!domain || !persona) return []

  const { data } = await deps.seo.rankedKeywords({
    target: domain.domainNormalized,
    locale: { languageCode: persona.language, countryCode: persona.country },
    limit: PROXY_RANKING_LIMIT,
    attribution: { kind: 'account', accountId },
  })

  return data.map((row) => ({ keyword: row.keyword, url: row.url, position: row.position }))
}

/**
 * The seam Lane D's topic gate consumes, filled.
 *
 * While this was a stand-in it answered "no match" to every question, which
 * meant every new page looked uncontested — and a store ending up with two
 * pages splitting one search shows no error anywhere. That is why the stub
 * report named this contract specifically, and why the report no longer lists
 * it.
 */
export class DbExistingTargetCheck implements ExistingTargetCheck {
  constructor(private readonly deps: ExistingTargetDeps) {}

  async check(cluster: QueryCluster, accountId: string): Promise<ExistingTargetOutcome> {
    return toContractOutcome(await this.full(cluster, accountId))
  }

  /**
   * The whole answer, for callers in this lane: the evidence behind the match
   * and the clearance a new page needs, neither of which the cross-lane seam
   * carries.
   */
  async full(cluster: QueryCluster, accountId: string): Promise<ExistingTargetResult> {
    const log = this.deps.logger ?? runtimeLogger()
    const result = findExistingTarget(await existingTargetInputFor(this.deps, accountId, cluster))

    log.info('existing_target_checked', {
      account_id: accountId,
      cluster: cluster.head,
      match: result.match?.strength ?? 'none',
      via: result.match?.via ?? null,
      limited_intelligence: result.limitedIntelligence,
    })

    return result
  }
}
