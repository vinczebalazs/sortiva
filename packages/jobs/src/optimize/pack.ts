import {
  excerptOf,
  extractHeadings,
  gapSet,
  normalisePageUrl,
  serpLocaleTag,
  serpSnapshotKey,
  type CoveragePrompt,
  type LlmClient,
  type Logger,
  type OptimizeEvidencePack,
  type OptimizePackFamily,
  type OptimizePackLinkCandidate,
  type OptimizePackProduct,
  type OptimizePackQuery,
  type OptimizePackRankingPage,
  type SeoDataProvider,
  type StorePageType,
  type SubtopicCoverage,
} from '@sortiva/core'
import {
  accountScope,
  findFamiliesByIds,
  findFreshSerpSnapshot,
  gscPageQueryTotals,
  listStorePages,
  productSubstanceForFamilies,
  readPersona,
  readStorePageBody,
  resultsOf,
  systemScope,
  type Db,
  type StorePageRow,
} from '@sortiva/db'
import { rules } from '@sortiva/rules'
import type { PageFetcher } from '@sortiva/providers'
import { runtimeLogger } from '../runtime/logging'
import { analyseIntentGap } from './analyse'

/**
 * Step 1 of main §10.3: everything a page recommendation may be made from,
 * assembled without asking a model anything.
 *
 * The one paid thing that happens here is step 2 — the subtopic comparison
 * against the pages ranking above this one — and it is reached through
 * `analyseIntentGap`, which holds its own cache, freshness rule and daily
 * allowance. When that comparison cannot be made the pack is still built and
 * the recommendation is made from the store's own facts alone: weaker advice,
 * honestly labelled, rather than none.
 */

export interface AssembleOptimizePackDeps {
  readonly db: Db
  readonly seo: SeoDataProvider
  readonly pageFetcher: PageFetcher
  readonly llm: LlmClient
  readonly coveragePrompt: CoveragePrompt
  readonly now?: () => Date
  readonly logger?: Logger
}

export interface AssembleOptimizePackInput {
  readonly accountId: string
  readonly opportunityId: string
  /** The page being improved — the opportunity's `entity_ref`. */
  readonly pageUrl: string
  /** The search this is about, from the opportunity's evidence. */
  readonly targetQuery: string
  readonly locale: { readonly language: string; readonly country: string }
}

export type AssembleOptimizePackOutcome =
  | { readonly status: 'assembled'; readonly pack: OptimizeEvidencePack; readonly coverageMade: boolean }
  /** The page is not in the inventory, so there is nothing to improve. */
  | { readonly status: 'unavailable'; readonly reason: 'page_not_in_inventory' | 'page_no_longer_in_store' }

/** The store's own text, markup stripped, long enough to write against and short enough to pay for. */
function pageText(row: StorePageRow): string {
  const html = readStorePageBody(row)
  if (!html) return ''
  return excerptOf(
    html
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
    PAGE_TEXT_MAX_CHARS,
  )
}

/**
 * How much of the merchant's page the writing call is shown. Long enough that
 * "do not restate what is already here" is a check the model can actually
 * apply, short enough that a 10,000-word landing page does not become the whole
 * prompt. It decides nothing a merchant sees.
 */
const PAGE_TEXT_MAX_CHARS = 6000

/**
 * Which of the store's other pages are offered as link candidates.
 *
 * Given only the pages the store still serves: a suggestion to link at a page
 * the merchant deleted is advice that breaks the page it is applied to.
 *
 * Pages sharing a product family come first — they are about the same things,
 * which is what makes a link between them worth a reader's click — and the rest
 * of the list is filled with the store's collections and standing pages.
 * Products and articles are not excluded, they are simply further down.
 */
function linkCandidates(
  pages: readonly StorePageRow[],
  page: StorePageRow,
  limit: number,
): OptimizePackLinkCandidate[] {
  const familyIds = new Set(page.familyIds)
  const others = pages.filter((row) => row.url !== page.url)
  const shares = (row: StorePageRow): boolean => row.familyIds.some((id) => familyIds.has(id))
  const rank = (row: StorePageRow): number => {
    if (shares(row)) return 0
    if (row.pageType === 'collection' || row.pageType === 'page') return 1
    return 2
  }

  return [...others]
    .sort((a, b) => rank(a) - rank(b) || a.url.localeCompare(b.url))
    .slice(0, limit)
    .map((row) => ({ url: row.url, title: row.title, pageType: row.pageType as StorePageType }))
}

function windowFor(now: Date, days: number): { startDate: string; endDate: string } {
  const end = new Date(now)
  const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
  return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) }
}

export async function assembleOptimizePack(
  deps: AssembleOptimizePackDeps,
  input: AssembleOptimizePackInput,
): Promise<AssembleOptimizePackOutcome> {
  const log = deps.logger ?? runtimeLogger()
  const now = (deps.now ?? (() => new Date()))()
  const scope = accountScope(input.accountId)
  const config = rules().defaults
  const wanted = normalisePageUrl(input.pageUrl)

  // Every row, deleted ones included, because the two refusals below are
  // different answers and a filtered read could not tell them apart: a page we
  // have never held is not the same as one the merchant has taken down.
  const pages = await listStorePages(deps.db, scope)
  const page = pages.find((row) => normalisePageUrl(row.url) === wanted)
  // A page with no checksum is one we have never actually read — the comparison
  // it would be cached under has no fingerprint to hang on.
  if (!page || page.checksum === null) {
    log.info('optimize_pack.page_not_in_inventory', {
      account_id: input.accountId,
      page: input.pageUrl,
    })
    return { status: 'unavailable', reason: 'page_not_in_inventory' }
  }
  // The row survives the merchant deleting the page, so that the walk finding
  // it again can put it straight back. It is still not something to buy a
  // search and a model call for.
  if (page.status === 'gone') {
    log.info('optimize_pack.page_no_longer_in_store', {
      account_id: input.accountId,
      page: input.pageUrl,
    })
    return { status: 'unavailable', reason: 'page_no_longer_in_store' }
  }

  const windowDays = config.signals.striking_distance.window_days
  const totals = await gscPageQueryTotals(
    deps.db,
    scope,
    windowFor(now, windowDays),
    config.clusters.min_query_impressions,
  )
  const queries: OptimizePackQuery[] = totals
    .filter((row) => normalisePageUrl(row.page) === wanted)
    .map((row) => ({
      query: row.query,
      clicks: row.clicks,
      impressions: row.impressions,
      position: row.position,
    }))

  const [familyRows, productRows, persona] = await Promise.all([
    findFamiliesByIds(deps.db, scope, page.familyIds),
    productSubstanceForFamilies(deps.db, scope, page.familyIds),
    readPersona(deps.db, scope),
  ])

  const families: OptimizePackFamily[] = familyRows.map((family) => ({
    familyId: family.id,
    name: family.name,
    differentiationAxes: family.differentiationAxes,
  }))
  const products: OptimizePackProduct[] = productRows.map((product) => ({
    productId: product.productId,
    familyId: product.familyId,
    title: product.title,
    factSheet: product.factSheet,
  }))

  const analysis = await analyseIntentGap(
    {
      db: deps.db,
      seo: deps.seo,
      pageFetcher: deps.pageFetcher,
      llm: deps.llm,
      prompt: deps.coveragePrompt,
      now: () => now,
      logger: log,
    },
    {
      accountId: input.accountId,
      page: {
        url: page.url,
        title: page.title,
        headings: (page.headingsJson as string[] | null) ?? [],
        excerpt: pageText(page),
        checksum: page.checksum,
      },
      query: input.targetQuery,
      locale: input.locale,
    },
  )

  let missingSubtopics: readonly SubtopicCoverage[] = []
  if (analysis.status === 'analysed') {
    missingSubtopics = gapSet(
      analysis.analysis.subtopics,
      config.signals.existing_page_intent_gap.subtopic_present_on_top_pages_min,
    )
  } else {
    // Not a failure of this generation: the comparison is one input of several,
    // and the store's own facts are still worth writing from. What it costs is
    // said out loud so a thin recommendation can be explained later.
    log.info('optimize_pack.no_coverage_analysis', {
      account_id: input.accountId,
      page: page.url,
      reason: analysis.status === 'paused' ? analysis.reason : analysis.reason,
    })
  }

  // Addresses and positions only. The pages themselves were read a moment ago
  // by the comparison above, and what they cover is already in its answer —
  // fetching them a second time would double the page-fetch bill for the same
  // information.
  const serpKey = serpSnapshotKey({
    query: input.targetQuery,
    locale: input.locale,
    depth: config.signals.existing_page_intent_gap.serp_top_n,
  })
  const snapshot = await findFreshSerpSnapshot(
    deps.db,
    systemScope('results pages are shared across stores; they carry no account'),
    serpKey,
    now,
  )
  const rankingPages: OptimizePackRankingPage[] = snapshot
    ? resultsOf(snapshot)
        .filter((result) => normalisePageUrl(result.url) !== wanted)
        .map((result) => ({
          url: result.url,
          domain: result.domain,
          position: result.position,
          title: result.title,
          headings: [],
          excerpt: '',
        }))
    : []

  const pack: OptimizeEvidencePack = {
    accountId: input.accountId,
    opportunityId: input.opportunityId,
    page: {
      url: page.url,
      pageType: page.pageType as StorePageType,
      title: page.title,
      seoTitle: page.seoTitle,
      seoDescription: page.seoDescription,
      headings: (page.headingsJson as string[] | null) ?? extractHeadings(readStorePageBody(page)),
      bodyText: pageText(page),
      outboundInternalLinks: page.outboundInternalLinks,
      checksum: page.checksum,
    },
    targetQuery: input.targetQuery,
    queries,
    queryWindowDays: windowDays,
    rankingPages,
    missingSubtopics,
    families,
    products,
    linkCandidates: linkCandidates(
      pages.filter((row) => row.status === 'live'),
      page,
      config.gates.optimize_recommendation.internal_link_candidates_max,
    ),
    persona: persona
      ? {
          description: persona.description,
          audience: persona.audience,
          tone: persona.tone,
          language: persona.language,
          country: persona.country,
        }
      : null,
    builtAt: now.toISOString(),
  }

  log.info('optimize_pack.assembled', {
    account_id: input.accountId,
    page: page.url,
    locale: serpLocaleTag(input.locale),
    queries: queries.length,
    missing_subtopics: missingSubtopics.length,
    products: products.length,
    coverage_made: analysis.status === 'analysed',
  })

  return { status: 'assembled', pack, coverageMade: analysis.status === 'analysed' }
}
