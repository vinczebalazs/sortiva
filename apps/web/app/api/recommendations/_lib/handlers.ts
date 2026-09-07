import {
  ACCOUNT_OPTIMIZE_PAUSED_FLAG,
  EntitlementInactiveError,
  assertEntitled,
  blockingPreconditionsFor,
  buildConsolidationRecommendation,
  consolidationInputFromEvidence,
  detectApplied,
  fieldRationale,
  optimizeRouteFor,
  packFacts,
  renderConsolidationView,
  renderRecommendationHtml,
  renderRecommendationMarkdown,
  resolveTargetQueryFromClusters,
  targetQueryFromEvidence,
  toIsoDate,
  type ConflictCode,
  type FixRecommendationView,
  type OptimizeEvidencePack,
  type OptimizeRecommendation,
  normalisePageUrl,
  type RecommendationLabels,
} from '@sortiva/core'
import {
  countOptimizeGenerationsSince,
  findFamiliesByIds,
  findOpportunityById,
  findOptimizeRecommendation,
  gscPageQueryTotals,
  isAccountFlagActive,
  latestOptimizeRecommendation,
  listOpenOpportunities,
  listOptimizeTasks,
  listQueryClusters,
  listStorePages,
  markOpportunityApplied,
  markOptimizeTask,
  productSubstanceForFamilies,
  releaseAbandonedOptimizeGenerations,
  transitionOpportunityStatus,
  readLifecycleState,
  type AccountScope,
  type Db,
  type OpportunityRow,
  type OptimizeRecommendationRow,
  type StorePageRow,
} from '@sortiva/db'
// Deep import to the file, not the `@sortiva/jobs` barrel — the barrel pulls the
// worker runtime and the threshold config's file loader into a route bundle
// that has no filesystem, which is the build failure
// `apps/web/app/api/calendar/_lib/handlers.ts` records.
import {
  enqueueOptimizeGeneration,
  enqueueOpportunityOutcomeMeasurement,
} from '@sortiva/jobs/optimize/queue'
// The refresh pool's front door, reached by the same kind of deep import and
// for the same reason: an improve-this-page press that lands on an article we
// published becomes a rewrite waiting for a calendar day.
import { requestArticleRefresh } from '@sortiva/jobs/generation/request-refresh'
import { rules } from '@sortiva/rules'
import type { AccountHandler } from '../../auth/_lib/session'

/**
 * `/api/recommendations` — the OPTIMIZE surface: ask for recommendations for
 * one page, read them, download them, and say you applied them.
 *
 * Nothing here writes to the merchant's store, and there is no route through
 * which it could: the only things this API changes are our own rows.
 *
 * The generation itself is not done in the request. It buys a results page,
 * reads competitor pages and makes two model calls — a minute or more — so the
 * request records that the merchant asked, and a background job does the work.
 * That is also what the frozen API contract describes: the POST answers `ok`,
 * and the recommendation arrives on the next read.
 */

export interface RecommendationsDeps {
  readonly db: Db
  readonly labels: RecommendationLabels
  readonly now?: () => Date
}

export type RecommendationRouteCtx = { readonly params: Promise<{ id: string }> }

function conflict(code: ConflictCode, message: string): Response {
  return Response.json({ error: { code, message } }, { status: 409 })
}

function notFound(): Response {
  return Response.json(
    { error: { code: 'recommendation_not_found', message: 'That recommendation is gone.' } },
    { status: 404 },
  )
}

function badRequest(message: string): Response {
  return Response.json({ error: { code: 'invalid_request', message } }, { status: 422 })
}

async function entitlementFailure(db: Db, scope: AccountScope): Promise<Response | undefined> {
  const lifecycle = await readLifecycleState(db, scope)
  try {
    assertEntitled(lifecycle?.subscription ?? null)
    return undefined
  } catch (error) {
    if (error instanceof EntitlementInactiveError) {
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.httpStatus },
      )
    }
    throw error
  }
}

/** Midnight UTC, which is the day the store's allowance is counted over. */
function startOfDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

/**
 * Hands back any page this store has been sitting on for longer than a
 * generation can take, before either of this API's two reads looks at a status.
 *
 * Both the button and the drawer do this, because both are places a merchant
 * would otherwise be stuck: the drawer would show a spinner that never
 * resolves, and the button would refuse them for a page nothing is working on.
 * There is no background sweeper — recovery happens the next time the merchant
 * looks at or asks about the page, which is the moment it matters to them.
 */
async function releaseAbandoned(deps: RecommendationsDeps, scope: AccountScope, now: Date): Promise<void> {
  const minutes = rules().defaults.gates.optimize_recommendation.abandoned_after_minutes
  await releaseAbandonedOptimizeGenerations(
    deps.db,
    scope,
    new Date(now.getTime() - minutes * 60_000),
    now,
  )
}

/** The store's own record of this page, if we hold one. Addresses that differ only by a trailing slash are the same page. */
async function storePageFor(
  db: Db,
  scope: AccountScope,
  url: string,
): Promise<StorePageRow | undefined> {
  const wanted = normalisePageUrl(url)
  const pages = await listStorePages(db, scope)
  return pages.find((page) => normalisePageUrl(page.url) === wanted)
}

/**
 * Something on this page has to be sorted out before writing for it is worth
 * anything — Google is not indexing it, or is treating another address as the
 * real one.
 *
 * The weekly scan already writes that onto the row when it re-measures. This
 * asks again, live, because the press is what commits the store's daily
 * allowance and its model spend, and a blocker found in the same pass as the
 * suggestion does not reach the row until the following week. The row is moved
 * to `blocked` as well as refused: a card that still says "Generate
 * recommendations" invites the merchant to press again, and a blocked
 * suggestion is information they need rather than something to hide.
 */
async function blockedByTechnicalObstacle(
  deps: RecommendationsDeps,
  scope: AccountScope,
  opportunity: OpportunityRow,
  now: Date,
): Promise<Response | undefined> {
  const open = await listOpenOpportunities(deps.db, scope)
  const preconditions = blockingPreconditionsFor(
    opportunity.entityRef,
    opportunity.recommendedAction,
    open,
  )
  if (preconditions.length === 0) return undefined

  await transitionOpportunityStatus(
    deps.db,
    scope,
    opportunity.id,
    { from: ['new', 'accepted'], to: 'blocked' },
    now,
  )
  return conflict(
    'opportunity_not_open',
    'Something has to be resolved on this page first.',
  )
}

/**
 * The FIX recommendation, rebuilt from the row rather than looked up.
 *
 * Nothing about it was ever stored: it is worked out from the same measurements
 * the card already shows, so a second copy in a table could only disagree with
 * the row the moment the next scan re-measures the search. Null where the row's
 * evidence is not a cannibalization — the one FIX shape this product produces a
 * recommendation for today — so the drawer shows the evidence and tasks it
 * already has rather than an empty section.
 */
async function fixViewFor(
  deps: RecommendationsDeps,
  scope: AccountScope,
  opportunity: OpportunityRow,
): Promise<FixRecommendationView | null> {
  const pages = await listStorePages(deps.db, scope)
  const input = consolidationInputFromEvidence(
    (opportunity.evidenceJson ?? []) as Parameters<typeof consolidationInputFromEvidence>[0],
    pages.map((page) => ({ url: page.url, outboundInternalLinks: page.outboundInternalLinks })),
  )
  if (!input) return null
  return renderConsolidationView(buildConsolidationRecommendation(input))
}

/**
 * `POST /api/recommendations` — "Generate recommendations", main §10.2.
 *
 * Refuses in four ways before spending anything, and each is a different thing
 * having gone wrong: not paid up (402), the opportunity is not one this can act
 * on (404/409), the store has used its allowance for today (409), or this call
 * type is paused for the store (409). The stored recommendation is served
 * unchanged when the evidence has not moved since it was made, which is what
 * stops the button costing a merchant their allowance for the same answer.
 *
 * None of those refusals is permanent, and that is deliberate. Marking a page
 * as being worked on does not spend the store's allowance and does not lock the
 * page: a press that is never picked up is handed back, and a press while a
 * generation is genuinely running is answered with "still going" rather than
 * refused.
 */
export function makeGenerateRecommendationHandler(deps: RecommendationsDeps): AccountHandler {
  return async (request, { scope }) => {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return badRequest('Send a JSON body naming the opportunity.')
    }
    const opportunityId = (body as { opportunityId?: unknown })?.opportunityId
    if (typeof opportunityId !== 'string' || opportunityId === '') {
      return badRequest('An opportunityId is required.')
    }

    const denied = await entitlementFailure(deps.db, scope)
    if (denied) return denied

    const now = (deps.now ?? (() => new Date()))()
    await releaseAbandoned(deps, scope, now)

    const opportunity = await findOpportunityById(deps.db, scope, opportunityId)
    if (!opportunity) return notFound()
    if (opportunity.recommendedAction !== 'optimize') {
      return conflict('opportunity_not_open', 'That opportunity is not a page to optimize.')
    }
    if (opportunity.status === 'blocked') {
      return conflict('opportunity_not_open', 'Something has to be resolved on this page first.')
    }

    // A second press while the first is genuinely still running is the same
    // request, not a conflict: say so and let the drawer keep waiting. It used
    // to be refused with a 409, and because nothing ever moved the page back
    // out of this status that refusal was permanent — the press before it had
    // locked the page out of ever being asked about again.
    if (opportunity.status === 'executing') {
      return Response.json({ state: 'generating', opportunityId: opportunity.id, generated: false })
    }

    const obstructed = await blockedByTechnicalObstacle(deps, scope, opportunity, now)
    if (obstructed) return obstructed

    // An article we published for this store is not something we hand the
    // merchant a list of edits for: we can rewrite it ourselves, through the
    // same evidence and the same quality bar the first draft went through.
    //
    // So the press produces no recommendation — but it is no longer a dead end
    // either. The article goes into the pool of rewrites waiting for a calendar
    // day, which is where this kind of work belongs, and the answer says so.
    // Nothing here reaches the calendar: the pool competes for days through the
    // ordinary replenishment pass, under the cap that stops rewrites crowding
    // out new coverage.
    const page = await storePageFor(deps.db, scope, opportunity.entityRef)
    if (page && optimizeRouteFor(page.pageType) === 'refresh_pool') {
      const admitted = page.articleId
        ? await requestArticleRefresh(
            { db: deps.db, now: () => now },
            {
              accountId: scope.accountId,
              articleId: page.articleId,
              source: 'optimize_on_our_own_article',
            },
          )
        : null
      return conflict(
        'opportunity_not_open',
        admitted?.ok
          ? 'We published this article, so we rewrite it rather than hand you edits for it. It is queued for a rewrite.'
          : 'We published this article, so we rewrite it rather than hand you edits for it.',
      )
    }

    // Main §10.2: regeneration is allowed once the evidence has changed, and
    // otherwise the stored recommendation is served. `updated_at` is what the
    // scan moves when it re-detects with new evidence.
    const held = await latestOptimizeRecommendation(deps.db, scope, opportunity.id)
    if (held && held.state === 'valid' && opportunity.updatedAt <= held.generatedAt) {
      return Response.json({ state: 'ready', recommendationId: held.id, generated: false })
    }

    const cap = rules().defaults.budgets.optimize.generations_per_account_per_day
    const used = await countOptimizeGenerationsSince(deps.db, scope, startOfDay(now))
    if (used >= cap) {
      return conflict(
        'optimize_daily_cap_reached',
        `${cap} per day — available tomorrow.`,
      )
    }

    if (await isAccountFlagActive(deps.db, scope, ACCOUNT_OPTIMIZE_PAUSED_FLAG)) {
      return conflict(
        'service_paused',
        'Delayed — we paused this action rather than continue with lower-quality or stale data.',
      )
    }

    // Guarded: two tabs racing at the same instant cannot both start a
    // generation, because only one of them changes a row. The store's
    // allowance is not spent here, though — nothing is spent until the work
    // actually runs, and the cap is re-read there against the same meter.
    const moved = await transitionOpportunityStatus(
      deps.db,
      scope,
      opportunity.id,
      { from: ['new', 'accepted'], to: 'executing' },
      now,
    )
    if (!moved) {
      return conflict('opportunity_already_updated', 'This opportunity was updated by the latest scan — refreshed.')
    }

    try {
      await enqueueOptimizeGeneration(deps.db, {
        accountId: scope.accountId,
        opportunityId: opportunity.id,
      })
    } catch (error) {
      // The page is marked as being worked on and the work was never asked
      // for. Put it back where it was rather than leave a page nobody will
      // ever pick up: the merchant can press again straight away.
      await transitionOpportunityStatus(
        deps.db,
        scope,
        opportunity.id,
        { from: ['executing'], to: opportunity.status },
        now,
      )
      throw error
    }

    return Response.json({ state: 'generating', opportunityId: opportunity.id, generated: true })
  }
}

interface RecommendationView {
  readonly id: string
  readonly state: 'generating' | 'ready' | 'failed_validation'
  readonly pageUrl: string
  readonly fields: readonly {
    field: string
    current: string | null
    suggested: string
    evidence: string | null
  }[]
  readonly sections: readonly { heading: string; copy: string; evidence: readonly string[] }[]
  readonly faq: readonly { q: string; a: string; evidence: readonly string[] }[]
  readonly internalLinksIn: readonly { fromUrl: string; anchor: string }[]
  readonly internalLinksOut: readonly { toUrl: string; anchor: string }[]
  readonly intentNote: string | null
  readonly failureReason: { templateKey: string; params: Record<string, string> } | null
  readonly generatedAt: string
}

function isFailed(row: OptimizeRecommendationRow): boolean {
  return row.state === 'failed_validation'
}

function viewOf(row: OptimizeRecommendationRow): RecommendationView {
  if (isFailed(row)) {
    return {
      id: row.id,
      state: 'failed_validation',
      pageUrl: row.pageUrl,
      fields: [],
      sections: [],
      faq: [],
      internalLinksIn: [],
      internalLinksOut: [],
      intentNote: null,
      // A template key, never the model's own words and never the lint text:
      // the merchant gets one sentence written by us. Invariant 8.
      failureReason: { templateKey: 'optimize.failedValidation.reason', params: {} },
      generatedAt: row.generatedAt.toISOString(),
    }
  }

  const recommendation = row.recommendationJson as OptimizeRecommendation
  return {
    id: row.id,
    state: 'ready',
    pageUrl: row.pageUrl,
    fields: [
      {
        field: 'title_tag',
        current: recommendation.title_tag.current,
        suggested: recommendation.title_tag.suggested,
        evidence: fieldRationale(recommendation.title_tag),
      },
      {
        field: 'meta_description',
        current: recommendation.meta_description.current,
        suggested: recommendation.meta_description.suggested,
        evidence: fieldRationale(recommendation.meta_description),
      },
    ],
    sections: recommendation.sections.map((section) => ({
      heading: section.heading,
      copy: section.suggested_copy,
      evidence: section.facts_used,
    })),
    faq: recommendation.faq.map((entry) => ({ q: entry.q, a: entry.a, evidence: entry.facts_used })),
    internalLinksIn: recommendation.internal_links.add_from.map((link) => ({
      fromUrl: link.url,
      anchor: link.anchor,
    })),
    internalLinksOut: recommendation.internal_links.add_to.map((link) => ({
      toUrl: link.url,
      anchor: link.anchor,
    })),
    intentNote: recommendation.intent_note,
    failureReason: null,
    generatedAt: row.generatedAt.toISOString(),
  }
}

/**
 * `GET /api/recommendations?opportunityId=…` — the drawer's own read.
 *
 * The "looks like you applied this" prompt (main §10.4) is computed here from
 * the page as the last inventory sync found it, rather than stored: it is a
 * question about the world right now, and a stored answer would keep asking
 * after the merchant had said no.
 */
export function makeReadRecommendationHandler(deps: RecommendationsDeps): AccountHandler {
  return async (request, { scope }) => {
    const opportunityId = new URL(request.url).searchParams.get('opportunityId')
    if (!opportunityId) return badRequest('An opportunityId is required.')

    await releaseAbandoned(deps, scope, (deps.now ?? (() => new Date()))())

    const opportunity = await findOpportunityById(deps.db, scope, opportunityId)
    if (!opportunity) return notFound()

    if (opportunity.recommendedAction === 'fix') {
      return Response.json({
        recommendation: null,
        fix: await fixViewFor(deps, scope, opportunity),
        tasks: [],
        looksApplied: null,
      })
    }

    const row = await latestOptimizeRecommendation(deps.db, scope, opportunityId)
    if (!row) {
      return Response.json({
        recommendation:
          opportunity.status === 'executing'
            ? { state: 'generating', opportunityId }
            : null,
        tasks: [],
        looksApplied: null,
      })
    }

    const tasks = await listOptimizeTasks(deps.db, scope, opportunityId)
    const view = viewOf(row)

    let looksApplied: { signals: readonly string[]; headings: readonly string[] } | null = null
    if (!isFailed(row)) {
      const pages = await listStorePages(deps.db, scope)
      const page = pages.find((candidate) => candidate.url === row.pageUrl)
      if (page) {
        const detection = detectApplied(row.recommendationJson as OptimizeRecommendation, {
          seoTitle: page.seoTitle,
          seoDescription: page.seoDescription,
          headings: (page.headingsJson as string[] | null) ?? [],
        })
        looksApplied = detection.looksApplied
          ? { signals: detection.signals, headings: detection.headingsFound }
          : null
      }
    }

    return Response.json({
      recommendation: view,
      tasks: tasks.map((task) => ({
        id: task.id,
        kind: task.kind,
        label: task.description,
        state: task.state,
      })),
      looksApplied,
      appliedAt: opportunity.appliedAt?.toISOString() ?? null,
    })
  }
}

/**
 * The evidence addresses in plain language, rebuilt from the store's own rows.
 *
 * The evidence pack a recommendation was made from is not kept — it is large,
 * and most of it is a snapshot of things that have their own home in the
 * database. What the download needs from it is only the labels, and those come
 * back from the families and products the citations name, for free.
 */
async function factsForDownload(
  db: Db,
  scope: AccountScope,
  pageUrl: string,
): Promise<ReturnType<typeof packFacts>> {
  const pages = await listStorePages(db, scope)
  const page = pages.find((candidate) => candidate.url === pageUrl)
  const familyIds = page?.familyIds ?? []
  const [families, products] = await Promise.all([
    findFamiliesByIds(db, scope, familyIds),
    productSubstanceForFamilies(db, scope, familyIds),
  ])

  const pack = {
    families: families.map((family) => ({
      familyId: family.id,
      name: family.name,
      differentiationAxes: family.differentiationAxes,
    })),
    products: products.map((product) => ({
      productId: product.productId,
      familyId: product.familyId,
      title: product.title,
      factSheet: product.factSheet,
    })),
    missingSubtopics: [],
  } as unknown as OptimizeEvidencePack

  return packFacts(pack)
}

/** `GET /api/recommendations/{id}/download?format=md|html` — main §10.4's deliverable. */
export function makeDownloadRecommendationHandler(
  deps: RecommendationsDeps,
): AccountHandler<RecommendationRouteCtx> {
  return async (request, { scope, route }) => {
    const { id } = await route.params
    const found = await findOptimizeRecommendation(deps.db, scope, id)
    if (!found || isFailed(found.recommendation)) return notFound()

    const format = new URL(request.url).searchParams.get('format') ?? 'md'
    if (format !== 'md' && format !== 'html') return badRequest('Ask for md or html.')

    const recommendation = found.recommendation.recommendationJson as OptimizeRecommendation
    const facts = await factsForDownload(deps.db, scope, found.recommendation.pageUrl)
    const input = {
      recommendation,
      page: {
        url: found.recommendation.pageUrl,
        targetQuery: await targetQueryFor(
          deps.db,
          scope,
          found.opportunity,
          (deps.now ?? (() => new Date()))(),
        ),
      },
      facts,
      labels: deps.labels,
    }

    const body = format === 'md' ? renderRecommendationMarkdown(input) : renderRecommendationHtml(input)
    return new Response(body, {
      headers: {
        'content-type': format === 'md' ? 'text/markdown; charset=utf-8' : 'text/html; charset=utf-8',
        'content-disposition': `attachment; filename="recommendations-${id}.${format}"`,
        // Advice about one merchant's own store, addressed to them.
        'cache-control': 'private, no-store',
      },
    })
  }
}

/**
 * The search the document names, resolved the same way the generation resolved
 * it: what the detection recorded, or the store's own pooled intent this page
 * is most shown for.
 *
 * Null rather than the page's address when neither exists. A download is
 * something a merchant reads and pastes into a brief, and a web address printed
 * under the word "search" is a claim about a shopper that nobody made.
 */
async function targetQueryFor(
  db: Db,
  scope: AccountScope,
  opportunity: OpportunityRow,
  now: Date,
): Promise<string | null> {
  const recorded = targetQueryFromEvidence(opportunity.evidenceJson)
  if (recorded !== null) return recorded

  const config = rules().defaults
  const end = new Date(now)
  end.setUTCDate(end.getUTCDate() - config.search_console.data_lag_days)
  const start = new Date(end)
  start.setUTCDate(start.getUTCDate() - config.clusters.window_days + 1)

  const [clusters, rows] = await Promise.all([
    listQueryClusters(db, scope),
    gscPageQueryTotals(
      db,
      scope,
      { startDate: toIsoDate(start), endDate: toIsoDate(end) },
      config.clusters.min_query_impressions,
    ),
  ])

  return resolveTargetQueryFromClusters({
    pageUrl: opportunity.entityRef,
    clusters: clusters.map((cluster) => ({
      headQuery: cluster.headQuery,
      memberQueries: cluster.memberQueries,
      clusterId: cluster.clusterId,
    })),
    rows,
  })
}

/**
 * `POST /api/recommendations/{id}/apply` — "Mark as applied", per task or whole
 * (main §10.4).
 *
 * Marking the whole thing applied is what starts the clock: the opportunity
 * completes, the moment is stamped, and the measurement of whether it worked is
 * booked for 28 days later — the first date on which there is anything honest
 * to say (main §9.6.10).
 */
export function makeApplyRecommendationHandler(
  deps: RecommendationsDeps,
): AccountHandler<RecommendationRouteCtx> {
  return async (request, { scope, route }) => {
    const { id } = await route.params
    const found = await findOptimizeRecommendation(deps.db, scope, id)
    if (!found || isFailed(found.recommendation)) return notFound()

    let body: unknown = {}
    try {
      body = await request.json()
    } catch {
      // An empty body means the whole recommendation.
    }
    const taskId = (body as { taskId?: unknown })?.taskId
    const now = (deps.now ?? (() => new Date()))()

    if (typeof taskId === 'string' && taskId !== '') {
      const task = await markOptimizeTask(deps.db, scope, { taskId, state: 'applied' }, now)
      if (!task) {
        return conflict('opportunity_already_updated', 'That task was already marked.')
      }
      return Response.json({ ok: true, taskId: task.id, state: task.state })
    }

    const opportunity = await markOpportunityApplied(
      deps.db,
      scope,
      found.recommendation.opportunityId,
      now,
    )
    if (!opportunity) {
      return conflict('opportunity_already_updated', 'This opportunity was updated by the latest scan — refreshed.')
    }

    const tasks = await listOptimizeTasks(deps.db, scope, found.recommendation.opportunityId)
    for (const task of tasks) {
      if (task.state === 'open') {
        await markOptimizeTask(deps.db, scope, { taskId: task.id, state: 'applied' }, now)
      }
    }

    const maturityDays = rules().defaults.learning.outcomes.maturity_days
    const dueAt = new Date(now.getTime() + maturityDays * 24 * 60 * 60 * 1000)
    await enqueueOpportunityOutcomeMeasurement(
      deps.db,
      {
        accountId: scope.accountId,
        opportunityId: found.recommendation.opportunityId,
        appliedAt: now.toISOString(),
      },
      dueAt,
    )

    return Response.json({
      ok: true,
      appliedAt: now.toISOString(),
      outcomeDueAt: dueAt.toISOString(),
    })
  }
}
