import {
  ACCOUNT_OPTIMIZE_PAUSED_FLAG,
  EntitlementInactiveError,
  assertEntitled,
  detectApplied,
  packFacts,
  renderRecommendationHtml,
  renderRecommendationMarkdown,
  type ConflictCode,
  type OptimizeEvidencePack,
  type OptimizeRecommendation,
  type RecommendationLabels,
} from '@sortiva/core'
import {
  countOptimizeGenerationsSince,
  findFamiliesByIds,
  findOpportunityById,
  findOptimizeRecommendation,
  isAccountFlagActive,
  latestOptimizeRecommendation,
  listOptimizeTasks,
  listStorePages,
  markOpportunityApplied,
  markOptimizeTask,
  productSubstanceForFamilies,
  transitionOpportunityStatus,
  readLifecycleState,
  type AccountScope,
  type Db,
  type OptimizeRecommendationRow,
} from '@sortiva/db'
// Deep import to the file, not the `@sortiva/jobs` barrel — the barrel pulls the
// worker runtime and the threshold config's file loader into a route bundle
// that has no filesystem, which is the build failure
// `apps/web/app/api/calendar/_lib/handlers.ts` records.
import {
  enqueueOptimizeGeneration,
  enqueueOpportunityOutcomeMeasurement,
} from '@sortiva/jobs/optimize/queue'
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
 * `POST /api/recommendations` — "Generate recommendations", main §10.2.
 *
 * Refuses in four ways before spending anything, and each is a different thing
 * having gone wrong: not paid up (402), the opportunity is not one this can act
 * on (404/409), the store has used its allowance for today (409), or this call
 * type is paused for the store (409). The stored recommendation is served
 * unchanged when the evidence has not moved since it was made, which is what
 * stops the button costing a merchant their allowance for the same answer.
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
    const opportunity = await findOpportunityById(deps.db, scope, opportunityId)
    if (!opportunity) return notFound()
    if (opportunity.recommendedAction !== 'optimize') {
      return conflict('opportunity_not_open', 'That opportunity is not a page to optimize.')
    }
    if (opportunity.status === 'blocked') {
      return conflict('opportunity_not_open', 'Something has to be resolved on this page first.')
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

    // Guarded, so two tabs cannot both start a generation: the second sees no
    // row change and is told the opportunity moved under it.
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

    await enqueueOptimizeGeneration(deps.db, {
      accountId: scope.accountId,
      opportunityId: opportunity.id,
    })

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
        evidence: recommendation.title_tag.rationale_key,
      },
      {
        field: 'meta_description',
        current: recommendation.meta_description.current,
        suggested: recommendation.meta_description.suggested,
        evidence: recommendation.meta_description.rationale_key,
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

    const opportunity = await findOpportunityById(deps.db, scope, opportunityId)
    if (!opportunity) return notFound()

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
        targetQuery: targetQueryOf(found.opportunity.evidenceJson, found.recommendation.pageUrl),
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

function targetQueryOf(evidence: unknown, fallback: string): string {
  if (!Array.isArray(evidence)) return fallback
  const facts = evidence as readonly { key?: unknown; value?: unknown }[]
  const found = facts.find((fact) => fact.key === 'query_cluster' || fact.key === 'query')
  return found && typeof found.value === 'string' ? found.value : fallback
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
