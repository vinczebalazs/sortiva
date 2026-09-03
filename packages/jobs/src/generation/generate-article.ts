import {
  GATE_DECISION_EVENT,
  accountAttribution,
  articleBodyOf,
  buildRepairRequest,
  checkGrounding,
  checkShape,
  internalLinkTargetsFor,
  lengthTargetFor,
  planClaims,
  runGate2,
  runGate3,
  selectShape,
  stableSlug,
  writeDraft,
  type ArticleShape,
  type ClaimPlan,
  type ClaimPlanPrompt,
  type CitableProduct,
  type ComparisonText,
  type ContradictionPrompt,
  type Draft,
  type DraftPrompt,
  type EvidencePack,
  type Gate2Result,
  type Gate3Result,
  type GroundingResult,
  type IntentClass,
  type JudgePrompt,
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
  markArticleRejectedByGate,
  publishedArticlesForAccount,
  recentArticleBodiesForAccount,
  rejectTopicByGateGuarded,
  saveDraftBody,
  slugsForAccount,
  type Db,
} from '@sortiva/db'
import { rules } from '@sortiva/rules'
import type { PageFetcher } from '@sortiva/providers'
import { assembleEvidencePack } from './assemble-evidence-pack'
import { runtimeLogger } from '../runtime/logging'

/**
 * The pipeline: evidence pack → Gate 2 → claim plan → draft → Gate 3. What
 * happens to a graded article afterwards — review, publish, export — is
 * `T4.5`'s and `T5.x`'s, not this one's.
 *
 * **The claim plan is written to `article_claims` before the draft's own
 * model call is made** — this is what makes "the writer only ever sees the
 * approved claims" a fact about the running system rather than a comment;
 * see `generate-article.test.ts`'s call-order assertion.
 *
 * **The draft is stored before it is graded**, for the same kind of reason: a
 * crash between the writer and the judge must not lose an article we already
 * paid to write.
 */

export interface GenerateArticleDeps {
  readonly db: Db
  readonly llm: LlmClient
  readonly pageFetcher: PageFetcher
  readonly seo: SeoDataProvider
  readonly claimPlanPrompt: ClaimPlanPrompt
  readonly draftPrompt: DraftPrompt
  readonly judgePrompt: JudgePrompt
  readonly contradictionPrompt: ContradictionPrompt
  /** The writer's prompt for a revision — the single repair attempt Gate 3 allows. */
  readonly revisePrompt: DraftPrompt
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
      readonly outcome: 'graded' | 'rejected_by_gate3'
      readonly gate2: Gate2Result
      readonly gate3: Gate3Result
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

  const draftInput = {
    prompt: deps.draftPrompt,
    accountId: input.accountId,
    targetKeyword: input.targetKeyword,
    shape,
    axes,
    claims: planResult.plan.claims,
    citableProducts,
    length,
    internalLinks,
  }

  const writeResult = await writeDraft({ llm: deps.llm }, draftInput)

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

  // Stored before grading: a crash between the writer and the judge must not
  // throw away an article we have already paid to write.
  await saveDraftBody(
    deps.db,
    scope,
    article.id,
    { title: draft.title, metaDescription: draft.metaDescription, body: articleBodyOf(draft) },
    now,
  )

  // ---- Gate 3. ----
  const gate3 = await runGate3(
    {
      llm: deps.llm,
      judgePrompt: deps.judgePrompt,
      contradictionPrompt: deps.contradictionPrompt,
      repairWriter: async ({ previousDraft, instructions }) => {
        const repaired = await deps.llm.complete<Draft>(
          buildRepairRequest({
            draftInput,
            revisePrompt: deps.revisePrompt,
            previousDraft,
            instructions,
          }),
        )
        return repaired.output
      },
    },
    {
      accountId: input.accountId,
      draft,
      plan: planResult.plan,
      pack,
      targetKeyword: input.targetKeyword,
      length,
      internalLinks,
      comparisons: await comparisonTextsFor(deps.db, scope, article.id, pack),
      languageCode: input.locale.languageCode,
      gates,
      generation,
    },
  )

  // The graded draft is the one that gets stored: after a repair, the article
  // a merchant would read is the revision, not the attempt that failed.
  if (gate3.repaired) {
    await saveDraftBody(
      deps.db,
      scope,
      article.id,
      {
        title: gate3.draft.title,
        metaDescription: gate3.draft.metaDescription,
        body: articleBodyOf(gate3.draft),
      },
      now,
    )
  }

  await insertGateDecision(
    deps.db,
    scope,
    {
      topicId: input.topicId,
      gate: 3,
      outcome: gate3.outcome,
      scoresJson: { ...gate3.audit, reason_params: gate3.reasonParams, model_calls: gate3.calls },
      reasonUserFacing: gate3.reasonTemplateKey,
      promptVersion: gate3.verdict?.promptVersion ?? null,
      modelId: gate3.verdict?.modelId ?? null,
    },
    now,
  )

  deps.capture?.capture({
    event: GATE_DECISION_EVENT,
    attribution: accountAttribution(input.accountId),
    properties: {
      gate: 3,
      outcome: gate3.outcome,
      prompt_version: gate3.verdict?.promptVersion ?? null,
      model_id: gate3.verdict?.modelId ?? null,
      ...(gate3.verdict?.scores ?? {}),
    },
  })

  if (!gate3.passed) {
    await markArticleRejectedByGate(deps.db, scope, article.id, now)
    await rejectTopicByGateGuarded(deps.db, scope, input.topicId, now)
    log.info('gate3_rejected', {
      account_id: input.accountId,
      topic_id: input.topicId,
      outcome: gate3.outcome,
      judge_calls: gate3.calls.judge,
    })
  }

  return {
    outcome: gate3.passed ? 'graded' : 'rejected_by_gate3',
    gate2,
    gate3,
    articleId: article.id,
    shape,
    claimPlan: planResult.plan,
    draft: gate3.draft,
    grounding: checkGrounding(gate3.draft, planResult.plan, citableProducts),
    shapeCheck: checkShape(shape, gate3.draft),
  }
}

/**
 * What the near-duplicate check compares against: the store's own earlier
 * articles (article #40 sounding like article #12) and the pages currently
 * ranking (rewriting the SERP back at itself). The article being graded is
 * excluded — it was stored a moment ago and would otherwise match itself
 * perfectly.
 */
async function comparisonTextsFor(
  db: Db,
  scope: ReturnType<typeof accountScope>,
  currentArticleId: string,
  pack: EvidencePack,
): Promise<ComparisonText[]> {
  const own = await recentArticleBodiesForAccount(db, scope, 25)
  const comparisons: ComparisonText[] = []

  for (const row of own) {
    if (row.id === currentArticleId) continue
    const body = row.bodyJson as { intro?: string; sections?: { body?: string }[]; faq?: { answer?: string }[] } | null
    if (!body) continue
    const text = [
      body.intro ?? '',
      ...(body.sections ?? []).map((s) => s.body ?? ''),
      ...(body.faq ?? []).map((f) => f.answer ?? ''),
    ].join('\n\n')
    if (text.trim() === '') continue
    comparisons.push({ label: row.title, kind: 'own_article', text })
  }

  for (const angle of pack.serp.competitorAngles) {
    if (angle.excerpt.trim() === '') continue
    comparisons.push({ label: `${angle.domain} (#${angle.position})`, kind: 'ranking_page', text: angle.excerpt })
  }

  return comparisons
}
