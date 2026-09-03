import {
  accountAttribution,
  assembleEvidencePack as assemblePackCore,
  buildCompetitorAngle,
  type CompetitorAngle,
  type EvidencePack,
  type EvidencePackFamily,
  type EvidencePackProduct,
  type IntentClass,
  type Logger,
  type SeoDataProvider,
  type SeoLocale,
} from '@sortiva/core'
import {
  accountScope,
  findFamiliesByIds,
  findFreshSerpSnapshot,
  productSubstanceForFamilies,
  resultsOf,
  systemScope,
  upsertSerpSnapshot,
  type Db,
} from '@sortiva/db'
import { rules } from '@sortiva/rules'
import type { PageFetcher } from '@sortiva/providers'
import { runtimeLogger } from '../runtime/logging'

/**
 * Evidence-pack assembly, main §8.3: "relevant fact sheets, DataForSEO SERP
 * context, competitor angles" — plus family axes, catalog images, and the
 * existing-target link task where Gate 1 found a weak match. The pure
 * shaping (dedupe, normalisation) is `packages/core/src/generation/evidence-pack.ts`;
 * this file does the fetching and caching around it.
 */

export interface AssembleEvidencePackDeps {
  readonly db: Db
  readonly seo: SeoDataProvider
  readonly pageFetcher: PageFetcher
  readonly now?: () => Date
  readonly logger?: Logger
}

export interface AssembleEvidencePackInput {
  readonly accountId: string
  readonly topicId: string
  readonly intentClass: IntentClass
  readonly targetKeyword: string
  readonly familyIds: readonly string[]
  readonly locale: SeoLocale
  /** Gate 1's link task (main §7.7 step 4), where the topic proceeded on a weak existing-target match. */
  readonly linkTaskUrl: string | null
}

const COMPETITOR_DEPTH = 3

function serpCacheKey(keyword: string, locale: SeoLocale, depth: number): string {
  const normalised = keyword.trim().toLowerCase().replace(/\s+/g, ' ')
  return `serp:${locale.languageCode.trim().toLowerCase()}-${locale.countryCode.trim().toUpperCase()}:${depth}:${normalised}`
}

export async function assembleEvidencePack(
  deps: AssembleEvidencePackDeps,
  input: AssembleEvidencePackInput,
): Promise<EvidencePack> {
  const log = deps.logger ?? runtimeLogger()
  const now = (deps.now ?? (() => new Date()))()
  const scope = accountScope(input.accountId)

  const [familyRows, productRows] = await Promise.all([
    findFamiliesByIds(deps.db, scope, input.familyIds),
    productSubstanceForFamilies(deps.db, scope, input.familyIds),
  ])

  const families: EvidencePackFamily[] = familyRows.map((f) => ({
    familyId: f.id,
    name: f.name,
    differentiationAxes: f.differentiationAxes,
  }))

  const products: EvidencePackProduct[] = productRows.map((p) => ({
    productId: p.productId,
    familyId: p.familyId,
    title: p.title,
    factSheet: p.factSheet,
    // No column exists yet to hold a Shopify image URL — see this card's
    // session report. Always empty until a schema wave adds one; `images.ts`
    // is written against the shape this will carry once it does.
    images: [],
  }))

  const cacheKey = serpCacheKey(input.targetKeyword, input.locale, COMPETITOR_DEPTH)
  const ttlDays = rules().defaults.discovery.cache.serp_snapshot_ttl_days
  let snapshot = await findFreshSerpSnapshot(deps.db, systemScope('evidence pack assembly'), cacheKey, now)

  if (!snapshot) {
    const serpResult = await deps.seo.serpTop({
      keyword: input.targetKeyword,
      locale: input.locale,
      depth: COMPETITOR_DEPTH,
      attribution: accountAttribution(input.accountId),
    })
    await upsertSerpSnapshot(deps.db, systemScope('evidence pack assembly'), {
      cacheKey,
      query: input.targetKeyword,
      locale: `${input.locale.languageCode}-${input.locale.countryCode}`,
      results: serpResult.data.map((r) => ({ position: r.position, url: r.url, domain: r.domain, title: r.title })),
      fetchedAt: now,
      expiresAt: new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000),
    })
    snapshot = await findFreshSerpSnapshot(deps.db, systemScope('evidence pack assembly'), cacheKey, now)
  }

  const topResults = snapshot ? resultsOf(snapshot).slice(0, COMPETITOR_DEPTH) : []

  const angles: CompetitorAngle[] = []
  const wordCounts: number[] = []
  for (const result of topResults) {
    try {
      const page = await deps.pageFetcher.fetch({ url: result.url })
      const { angle, wordCount } = buildCompetitorAngle({
        url: result.url,
        domain: result.domain,
        position: result.position,
        bodyHtml: page.body,
      })
      angles.push(angle)
      wordCounts.push(wordCount)
    } catch (error) {
      // Main §14.4: degrade, do not fail the pack over one unreachable
      // competitor page — the SERP ranking itself still came from the
      // vendor, only the fetched-content half of this one result is missing.
      log.warn('evidence_pack_competitor_fetch_failed', {
        account_id: input.accountId,
        url: result.url,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return assemblePackCore({
    accountId: input.accountId,
    topicId: input.topicId,
    intentClass: input.intentClass,
    targetKeyword: input.targetKeyword,
    families,
    products,
    serp: {
      keyword: input.targetKeyword,
      locale: `${input.locale.languageCode}-${input.locale.countryCode}`,
      topResultCount: topResults.length,
      averageWordCount: wordCounts.length === 0 ? null : wordCounts.reduce((a, b) => a + b, 0) / wordCounts.length,
      competitorAngles: angles,
    },
    linkTasks: input.linkTaskUrl ? [{ url: input.linkTaskUrl, reason: 'existing_target_weak_match' }] : [],
    now,
  })
}
