import {
  GATE_DECISION_EVENT,
  accountAttribution,
  checkGrounding,
  checkShape,
  internalLinkTargetsFor,
  lengthTargetFor,
  planClaims,
  runGate2,
  selectShape,
  stableSlug,
  writeDraft,
  type ArticleShape,
  type ClaimPlan,
  type ClaimPlanPrompt,
  type CitableProduct,
  type Draft,
  type DraftPrompt,
  type EvidencePack,
  type Gate2Result,
  type GroundingResult,
  type IntentClass,
  type LlmClient,
  type Logger,
  type PlannedClaim,
  type PosthogCapture,
  type QueryCluster,
  type SeoDataProvider,
  type SeoLocale,
  type ShapeCheckResult,
} from '@sortiva/core'
import {
  accountScope,
  insertArticleClaims,
  insertArticleProductRefs,
  insertArticleStub,
  insertGateDecision,
  publishedArticlesForAccount,
  rejectTopicByGateGuarded,
  slugsForAccount,
  type Db,
} from '@sortiva/db'
import { rules } from '@sortiva/rules'
import type { PageFetcher } from '@sortiva/providers'
import { assembleEvidencePack } from './assemble-evidence-pack'
import { runtimeLogger } from '../runtime/logging'

/**
 * The T4.3 pipeline: evidence pack → Gate 2 → claim plan → draft. Ends where
 * this card ends — a graded, Gate-3-checked, published article is `T4.4`'s
 * and `T4.5`'s job, not this one's.
 *
 * **The claim plan is written to `article_claims` before the draft's own
 * model call is made** — this is what makes "the writer only ever sees the
 * approved claims" a fact about the running system rather than a comment;
 * see `generate-article.test.ts`'s call-order assertion.
 */

export interface GenerateArticleDeps {
  readonly db: Db
  readonly llm: LlmClient
  readonly pageFetcher: PageFetcher
  readonly seo: SeoDataProvider
  readonly claimPlanPrompt: ClaimPlanPrompt
  readonly draftPrompt: DraftPrompt
  readonly capture?: Pick<PosthogCapture, 'capture'>
  readonly now?: () => Date
  readonly logger?: Logger
}

export interface GenerateArticleInput {
  readonly accountId: string
  readonly topicId: string
  readonly intentClass: IntentClass
  readonly cluster: Pick<QueryCluster, 'head' | 'members'>
  readonly targetKeyword: string
  readonly familyIds: readonly string[]
  readonly locale: SeoLocale
  /** Gate 1's link task (main §7.7 step 4), carried through from topic admission. */
  readonly linkTaskUrl: string | null
}

export type GenerateArticleResult =
  | {
      readonly outcome: 'held_thin_pack'
      readonly gate2: Gate2Result
      readonly articleId: null
      readonly draft: null
      readonly claimPlan: null
    }
  | {
      readonly outcome: 'drafted'
      readonly gate2: Gate2Result
      readonly articleId: string
      readonly shape: ArticleShape
      readonly claimPlan: ClaimPlan
      readonly draft: Draft
      readonly grounding: GroundingResult
      readonly shapeCheck: ShapeCheckResult
    }

/** The products a claim actually names — what the writer may cite by id (`draft.ts`'s `citableProducts`), never the pack itself. */
function citableProductsFrom(pack: EvidencePack, claims: readonly PlannedClaim[]): CitableProduct[] {
  const productIds = new Set<string>()
  for (const claim of claims) {
    for (const ref of claim.evidence) {
      if (ref.kind === 'product') productIds.add(ref.productId)
    }
  }
  return pack.products
    .filter((p) => productIds.has(p.productId))
    .map((p, i) => ({ id: `p${i + 1}`, productId: p.productId, title: p.title }))
}

export async function generateArticle(
  deps: GenerateArticleDeps,
  input: GenerateArticleInput,
): Promise<GenerateArticleResult> {
  const log = deps.logger ?? runtimeLogger()
  const now = (deps.now ?? (() => new Date()))()
  const scope = accountScope(input.accountId)
  const gates = rules().forLocale(input.locale.languageCode).gates
  const generation = rules().forLocale(input.locale.languageCode).generation

  const pack = await assembleEvidencePack(
    { db: deps.db, seo: deps.seo, pageFetcher: deps.pageFetcher, now: () => now, logger: log },
    {
      accountId: input.accountId,
      topicId: input.topicId,
      intentClass: input.intentClass,
      targetKeyword: input.targetKeyword,
      familyIds: input.familyIds,
      locale: input.locale,
      linkTaskUrl: input.linkTaskUrl,
    },
  )

  const gate2 = runGate2(pack, gates.evidence_pack_check)

  if (gate2.outcome === 'held_thin_pack') {
    await insertGateDecision(
      deps.db,
      scope,
      {
        topicId: input.topicId,
        gate: 2,
        outcome: gate2.outcome,
        scoresJson: {
          distinctClaimCount: gate2.distinctClaimCount,
          boilerplateRatio: gate2.boilerplateRatio,
          boilerplateEntries: gate2.boilerplateEntries,
        },
        reasonUserFacing: gate2.reasonTemplateKey,
      },
      now,
    )
    await rejectTopicByGateGuarded(deps.db, scope, input.topicId, now)
    deps.capture?.capture({
      event: GATE_DECISION_EVENT,
      attribution: accountAttribution(input.accountId),
      properties: { gate: 2, outcome: gate2.outcome, prompt_version: null, model_id: null },
    })
    log.info('gate2_held_thin_pack', { account_id: input.accountId, topic_id: input.topicId })
    return { outcome: 'held_thin_pack', gate2, articleId: null, draft: null, claimPlan: null }
  }

  // ---- Claim plan: written and persisted before the draft's own model call. ----
  const planResult = await planClaims({ llm: deps.llm, prompt: deps.claimPlanPrompt }, pack)

  const existingSlugs = await slugsForAccount(deps.db, scope)
  const slug = stableSlug(input.targetKeyword, existingSlugs)
  // Titled from the target keyword until the draft names something better —
  // `articles.title` is `NOT NULL` and the row must exist before claims can
  // reference it by `article_id`.
  const article = await insertArticleStub(
    deps.db,
    scope,
    { topicId: input.topicId, title: input.targetKeyword, slug, targetKeyword: input.targetKeyword, state: 'draft' },
    now,
  )

  await insertArticleClaims(
    deps.db,
    scope,
    article.id,
    planResult.plan.claims.map((c) => ({ text: c.text, kind: c.kind, confidence: c.confidence, evidence: c.evidence })),
    now,
  )

  // ---- Draft: the writer's model call, made only after the plan above is durable. ----
  const shape = selectShape(input.intentClass, input.cluster)
  const axes = pack.families.flatMap((f) => f.differentiationAxes)
  const citableProducts = citableProductsFrom(pack, planResult.plan.claims)
  const relatedArticles = await publishedArticlesForAccount(deps.db, scope, 5)
  const internalLinks = internalLinkTargetsFor(pack, relatedArticles)
  const length = lengthTargetFor(pack.serp, generation.length)

  const writeResult = await writeDraft(
    { llm: deps.llm },
    {
      prompt: deps.draftPrompt,
      accountId: input.accountId,
      targetKeyword: input.targetKeyword,
      shape,
      axes,
      claims: planResult.plan.claims,
      citableProducts,
      length,
      internalLinks,
    },
  )

  const draft = writeResult.draft
  const citableById = new Map(citableProducts.map((p) => [p.id, p]))
  const productMentionRefs = draft.productMentions.flatMap((mention) => {
    const citable = citableById.get(mention.id)
    if (!citable) return []
    const familyId = pack.products.find((p) => p.productId === citable.productId)?.familyId ?? null
    return [
      {
        productId: citable.productId,
        familyId,
        refType: mention.refType,
        placeholderKey: mention.id,
        fieldsRendered: mention.fields,
      },
    ]
  })

  if (productMentionRefs.length > 0) {
    await insertArticleProductRefs(deps.db, scope, article.id, productMentionRefs, now)
  }

  return {
    outcome: 'drafted',
    gate2,
    articleId: article.id,
    shape,
    claimPlan: planResult.plan,
    draft,
    grounding: checkGrounding(draft, planResult.plan, citableProducts),
    shapeCheck: checkShape(shape, draft),
  }
}
