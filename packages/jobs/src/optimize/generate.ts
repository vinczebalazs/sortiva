import {
  accountAttribution,
  blockingPreconditionsFor,
  gradeRecommendation,
  lintMessages,
  lintRecommendation,
  generateRecommendation,
  normalisePageUrl,
  optimizeRouteFor,
  type JudgeLite,
  type Logger,
  type NotificationEmitter,
  type OptimizeEvidencePack,
  type OptimizeLintResult,
  type OptimizeRecommendation,
  type RecommendationPrompt,
} from '@sortiva/core'
import {
  accountScope,
  countOptimizeGenerationsSince,
  findOpportunityById,
  listOpenOpportunities,
  listStorePages,
  readPersona,
  storeOptimizeRecommendation,
  transitionOpportunityStatus,
  type AccountScope,
  type Db,
  type OptimizeTaskWrite,
} from '@sortiva/db'
import { rules } from '@sortiva/rules'
import { mayCallTypeRun } from '../runtime/gate'
import { runtimeLogger } from '../runtime/logging'
import { assembleOptimizePack, type AssembleOptimizePackDeps } from './pack'

/**
 * One OPTIMIZE generation, end to end: assemble the evidence, ask for the
 * edits, check them, grade them, and write down what survives.
 *
 * Two rules shape the whole thing and are worth stating before the code.
 *
 * **Never a half-recommendation.** A run that cannot produce something safe
 * stores a `failed_validation` record and shows the merchant one sentence
 * saying so. It never shows the parts that passed: a merchant reading three
 * good suggestions has no way to know a fourth was dropped for asserting
 * something their store never recorded.
 *
 * **One re-ask, and it is spent on the free checks.** If the lints fail we ask
 * again with the failures attached — those are objective and the model can act
 * on them. If the grader then fails it, that is the end: paying a third time to
 * talk a recommendation past its own grader is how a quality bar becomes a
 * formality.
 */

export interface GenerateOptimizeDeps extends AssembleOptimizePackDeps {
  readonly recommendationPrompt: RecommendationPrompt
  /** The grader. Built by the caller so the criteria and its prompt are explicit. */
  readonly judge: (accountId: string) => JudgeLite
  readonly notifications?: NotificationEmitter
}

export interface GenerateOptimizeInput {
  readonly accountId: string
  readonly opportunityId: string
}

export type GenerateOptimizeOutcome =
  | {
      readonly status: 'generated'
      readonly recommendationId: string
      readonly recommendation: OptimizeRecommendation
      readonly attempts: number
    }
  | {
      readonly status: 'failed_validation'
      readonly recommendationId: string
      /** What stopped it, in the words the re-ask was given. Logged and stored, never shown raw. */
      readonly reasons: readonly string[]
    }
  /** The store's daily allowance for this call type is spent, or work is paused. Nothing was bought. */
  | { readonly status: 'paused'; readonly flag?: string; readonly reason: string }
  /** Nothing to work on: the opportunity is gone, is not an OPTIMIZE, or its page is not in the inventory. */
  | { readonly status: 'skipped'; readonly reason: string }

/** The search the recommendation is about, read off the evidence the scan recorded. */
function targetQueryOf(evidence: unknown, fallback: string): string {
  if (!Array.isArray(evidence)) return fallback
  const facts = evidence as readonly { key?: unknown; value?: unknown }[]
  for (const key of ['query_cluster', 'query', 'keyword']) {
    const found = facts.find((fact) => fact.key === key)
    if (found && typeof found.value === 'string' && found.value.trim() !== '') return found.value
  }
  return fallback
}

/**
 * The units the merchant marks applied one at a time (main §10.4). One per
 * field, one per suggested section and answer, one for the links — the same
 * granularity the drawer shows them at.
 */
function tasksFor(recommendation: OptimizeRecommendation): OptimizeTaskWrite[] {
  const tasks: OptimizeTaskWrite[] = []

  if (recommendation.title_tag.suggested !== (recommendation.title_tag.current ?? '')) {
    tasks.push({
      kind: 'title_rewrite',
      description: recommendation.title_tag.suggested,
      suggestedCopyRef: 'title_tag',
      evidenceRefs: [],
    })
  }
  if (recommendation.meta_description.suggested !== (recommendation.meta_description.current ?? '')) {
    tasks.push({
      kind: 'meta_rewrite',
      description: recommendation.meta_description.suggested,
      suggestedCopyRef: 'meta_description',
      evidenceRefs: [],
    })
  }
  recommendation.sections.forEach((section, index) => {
    tasks.push({
      kind: 'add_section',
      description: section.heading,
      suggestedCopyRef: `sections[${index}]`,
      evidenceRefs: section.facts_used,
    })
  })
  recommendation.faq.forEach((entry, index) => {
    tasks.push({
      kind: 'add_faq',
      description: entry.q,
      suggestedCopyRef: `faq[${index}]`,
      evidenceRefs: entry.facts_used,
    })
  })
  const links = recommendation.internal_links
  if (links.add_from.length > 0 || links.add_to.length > 0) {
    tasks.push({
      kind: 'internal_links',
      description: [...links.add_from, ...links.add_to].map((link) => link.url).join(', '),
      suggestedCopyRef: 'internal_links',
      evidenceRefs: [],
    })
  }

  return tasks
}

/** Midnight UTC, the day the store's allowance is counted over — the same day the API counts. */
function startOfDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

/**
 * Hands the page back to the merchant.
 *
 * Guarded on the status it expects, so a run that has already moved the page on
 * cannot pull it backwards, and calling it twice does nothing the second time.
 */
async function handBack(db: Db, scope: AccountScope, opportunityId: string, now: Date): Promise<void> {
  await transitionOpportunityStatus(db, scope, opportunityId, { from: ['executing'], to: 'accepted' }, now)
}

/**
 * The page is marked as being worked on for as long as this runs, and **every**
 * way out of it has to unmark it.
 *
 * There used to be exactly two: finishing, and failing our own checks. A
 * refusal (this call type switched off for the store), a skip (the page is no
 * longer in the store's inventory) and any unexpected error all left the page
 * marked for ever — a spinner that never resolves and a button that refuses
 * from then on, repairable only by editing the database. So the release lives
 * out here, where it covers the paths nobody thought of as well as the ones
 * they did, rather than being repeated at each return.
 */
export async function generateOptimizeRecommendation(
  deps: GenerateOptimizeDeps,
  input: GenerateOptimizeInput,
): Promise<GenerateOptimizeOutcome> {
  const log = deps.logger ?? runtimeLogger()
  const now = (deps.now ?? (() => new Date()))()
  const scope = accountScope(input.accountId)

  try {
    const outcome = await runGeneration(deps, input, now, log)
    // The finished path moves the page on itself, with the recommendation
    // attached; everything else leaves it where it was and needs handing back.
    if (outcome.status !== 'generated') {
      await handBack(deps.db, scope, input.opportunityId, now)
    }
    return outcome
  } catch (error) {
    try {
      await handBack(deps.db, scope, input.opportunityId, now)
    } catch (releaseError) {
      // Never let the repair hide what actually went wrong.
      log.error('optimize_reco.hand_back_failed', {
        account_id: input.accountId,
        opportunity_id: input.opportunityId,
        error_class: releaseError instanceof Error ? releaseError.name : 'unknown',
      })
    }
    throw error
  }
}

async function runGeneration(
  deps: GenerateOptimizeDeps,
  input: GenerateOptimizeInput,
  now: Date,
  log: Logger,
): Promise<GenerateOptimizeOutcome> {
  const scope = accountScope(input.accountId)
  const config = rules()
  const limits = config.defaults.gates.optimize_recommendation

  const gate = await mayCallTypeRun(deps.db, input.accountId, 'optimize_reco', log)
  if (!gate.allowed) {
    log.info('optimize_reco.paused', {
      account_id: input.accountId,
      opportunity_id: input.opportunityId,
      reason: gate.reason,
    })
    return {
      status: 'paused',
      reason: gate.reason,
      ...(gate.reason === 'paused' ? { flag: gate.flag } : {}),
    }
  }

  const opportunity = await findOpportunityById(deps.db, scope, input.opportunityId)
  if (!opportunity) return { status: 'skipped', reason: 'opportunity_not_found' }
  if (opportunity.recommendedAction !== 'optimize') {
    return { status: 'skipped', reason: 'not_an_optimize_opportunity' }
  }

  // A merchant can say "not interested" about a page while we are working on
  // it, and their answer is not made to wait for us. The row leaves "being
  // worked on" the instant they press, so a run that no longer holds it stops
  // here — before anything is bought — rather than finishing work nobody
  // wants. The same check catches a redelivered job whose first delivery
  // already finished: the queue promises at-least-once, and paying twice for
  // one press is exactly what that promise costs if nobody looks.
  if (opportunity.status !== 'executing') {
    log.info('optimize_reco.no_longer_ours', {
      account_id: input.accountId,
      opportunity_id: opportunity.id,
      status: opportunity.status,
    })
    return { status: 'skipped', reason: 'no_longer_being_worked_on' }
  }

  // Asked again here, not only at the press. A run waits in the queue, and in
  // that time a scan can find that Google is not indexing this page or is
  // treating another address as the real one — at which point better copy on it
  // cannot help, and this is the last moment before anything is bought.
  const blocked = blockingPreconditionsFor(
    opportunity.entityRef,
    opportunity.recommendedAction,
    await listOpenOpportunities(deps.db, scope),
  )
  if (blocked.length > 0) {
    log.info('optimize_reco.blocked_by_precondition', {
      account_id: input.accountId,
      opportunity_id: opportunity.id,
      preconditions: blocked,
    })
    return { status: 'skipped', reason: 'blocked_by_precondition' }
  }

  // An article we published for this store is rewritten through the article
  // pipeline, never handed back as a list of edits. Checked before the pack is
  // assembled, because assembling it is where the money goes.
  const wanted = normalisePageUrl(opportunity.entityRef)
  const page = (await listStorePages(deps.db, scope)).find(
    (candidate) => normalisePageUrl(candidate.url) === wanted,
  )
  if (page && optimizeRouteFor(page.pageType) === 'refresh_pool') {
    return { status: 'skipped', reason: 'our_own_article_goes_to_the_refresh_pool' }
  }

  // The store's daily allowance, re-read here rather than trusted from the
  // request that asked for this. The request's check is a courtesy — it lets a
  // merchant be told "tomorrow" straight away instead of watching a spinner —
  // but it cannot be the enforcement, because several presses can be accepted
  // before any of them has produced anything to count. This runs under the
  // account's lock, one generation at a time, against the recommendations
  // actually written today, so the cap holds however many presses arrive.
  const cap = config.defaults.budgets.optimize.generations_per_account_per_day
  const spent = await countOptimizeGenerationsSince(deps.db, scope, startOfDay(now))
  if (spent >= cap) {
    log.info('optimize_reco.daily_cap_reached', {
      account_id: input.accountId,
      opportunity_id: opportunity.id,
      spent,
      cap,
    })
    return { status: 'paused', reason: 'daily_cap_reached' }
  }

  const assembled = await assembleOptimizePack(deps, {
    accountId: input.accountId,
    opportunityId: opportunity.id,
    pageUrl: opportunity.entityRef,
    targetQuery: targetQueryOf(opportunity.evidenceJson, opportunity.entityRef),
    locale: await localeFor(deps, input.accountId),
  })
  if (assembled.status === 'unavailable') {
    return { status: 'skipped', reason: assembled.reason }
  }
  const pack = assembled.pack

  let attempts = 0
  let lastLint: OptimizeLintResult | undefined
  let accepted: { recommendation: OptimizeRecommendation; modelId: string; promptVersion: string } | undefined

  for (let attempt = 0; attempt <= limits.regenerations_max; attempt += 1) {
    attempts += 1
    const generated = await generateRecommendation(
      { llm: deps.llm, prompt: deps.recommendationPrompt },
      {
        pack,
        limits: {
          titleMaxChars: limits.title_max_chars,
          metaMaxChars: limits.meta_description_max_chars,
        },
        ...(lastLint ? { lintErrors: lintMessages(lastLint) } : {}),
      },
    )

    const lint = lintRecommendation(generated.recommendation, { pack, config: limits })
    if (lint.passed) {
      accepted = {
        recommendation: generated.recommendation,
        modelId: generated.modelId,
        promptVersion: generated.promptVersion,
      }
      break
    }

    lastLint = lint
    log.info('optimize_reco.lint_failed', {
      account_id: input.accountId,
      opportunity_id: opportunity.id,
      attempt: attempts,
      checks: [...new Set(lint.issues.map((issue) => issue.check))],
    })
  }

  if (!accepted) {
    return failValidation(deps, {
      accountId: input.accountId,
      opportunity,
      pack,
      reasons: lastLint ? lintMessages(lastLint) : [],
      judgeScores: null,
      promptVersion: deps.recommendationPrompt.version,
      modelId: 'unknown',
      rulesVersion: config.rulesVersion,
      now,
      log,
    })
  }

  const grade = await gradeRecommendation(
    deps.judge(input.accountId),
    accepted.recommendation,
    pack,
    limits,
  )

  if (!grade.passed) {
    return failValidation(deps, {
      accountId: input.accountId,
      opportunity,
      pack,
      reasons: grade.failed.map(
        (outcome) => `${outcome.criterion} scored ${outcome.score}, below the floor of ${outcome.floor}`,
      ),
      judgeScores: grade.verdict,
      promptVersion: accepted.promptVersion,
      modelId: accepted.modelId,
      rulesVersion: config.rulesVersion,
      now,
      log,
    })
  }

  // Asked once more, because the model call is where the time goes and a
  // merchant can have dismissed the page during it. Nothing is written and
  // nothing is announced over an answer they have already given; the call we
  // paid for is ours to absorb.
  const stillOurs = await findOpportunityById(deps.db, scope, opportunity.id)
  if (stillOurs?.status !== 'executing') {
    log.info('optimize_reco.abandoned_mid_run', {
      account_id: input.accountId,
      opportunity_id: opportunity.id,
      status: stillOurs?.status ?? 'gone',
    })
    return { status: 'skipped', reason: 'abandoned_while_generating' }
  }

  const row = await storeOptimizeRecommendation(
    deps.db,
    scope,
    {
      opportunityId: opportunity.id,
      pageUrl: pack.page.url,
      recommendationJson: accepted.recommendation,
      judgeScoresJson: grade.verdict,
      promptVersion: accepted.promptVersion,
      modelId: accepted.modelId,
      rulesVersion: config.rulesVersion,
      state: 'valid',
    },
    tasksFor(accepted.recommendation),
  )
  if (!row) return { status: 'skipped', reason: 'opportunity_not_found' }

  // Back to open, with the recommendation attached. Unapplied recommendations
  // do not nag (main §10.4): the opportunity simply stays on the list until the
  // merchant marks it applied or its evidence expires.
  await transitionOpportunityStatus(
    deps.db,
    scope,
    opportunity.id,
    { from: ['executing'], to: 'accepted' },
    now,
  )

  if (deps.notifications) {
    await deps.notifications.emit(
      'optimize_recommendation_ready',
      { opportunity_id: opportunity.id },
      opportunity.id,
      accountAttribution(input.accountId),
    )
  }

  log.info('optimize_reco.generated', {
    account_id: input.accountId,
    opportunity_id: opportunity.id,
    recommendation_id: row.id,
    attempts,
    coverage_made: assembled.coverageMade,
    sections: accepted.recommendation.sections.length,
  })

  return {
    status: 'generated',
    recommendationId: row.id,
    recommendation: accepted.recommendation,
    attempts,
  }
}

/**
 * The failure path, which stores a record rather than nothing.
 *
 * A stored `failed_validation` row is what lets the card say "we could not
 * produce a safe recommendation for this page" instead of looking like a button
 * that did nothing, and it is what stops a merchant clicking again into the
 * same wall all afternoon: the generation happened, it counted against the
 * day's allowance, and the answer is on the record.
 *
 * No notification is emitted here. The only type we have says the
 * recommendations are ready, and they are not.
 */
async function failValidation(
  deps: GenerateOptimizeDeps,
  input: {
    accountId: string
    opportunity: { id: string }
    pack: OptimizeEvidencePack
    reasons: readonly string[]
    judgeScores: unknown
    promptVersion: string
    modelId: string
    rulesVersion: string
    now: Date
    log: Logger
  },
): Promise<GenerateOptimizeOutcome> {
  const scope = accountScope(input.accountId)
  const row = await storeOptimizeRecommendation(deps.db, scope, {
    opportunityId: input.opportunity.id,
    pageUrl: input.pack.page.url,
    // Deliberately not the rejected suggestions: nothing may render them, and a
    // column holding them is a column somebody later renders. What is kept is
    // why it failed.
    recommendationJson: { failed: true, reasons: [...input.reasons] },
    judgeScoresJson: input.judgeScores,
    promptVersion: input.promptVersion,
    modelId: input.modelId,
    rulesVersion: input.rulesVersion,
    state: 'failed_validation',
  })

  input.log.warn('optimize_reco.failed_validation', {
    account_id: input.accountId,
    opportunity_id: input.opportunity.id,
    reasons: [...input.reasons],
  })

  return {
    status: 'failed_validation',
    recommendationId: row?.id ?? '',
    reasons: input.reasons,
  }
}

/** The store's own language and market, which is what its search results are read in. */
async function localeFor(
  deps: GenerateOptimizeDeps,
  accountId: string,
): Promise<{ language: string; country: string }> {
  const persona = await readPersona(deps.db, accountScope(accountId))
  return { language: persona?.language ?? 'en', country: persona?.country ?? 'US' }
}
