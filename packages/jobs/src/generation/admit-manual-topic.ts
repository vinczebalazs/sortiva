import {
  runGate1,
  manualAddOutcome,
  isLimitedIntelligence,
  substanceInventory,
  accountAttribution,
  GATE_DECISION_EVENT,
  type ExistingTargetCheck,
  type Gate1ReasonCard,
  type Logger,
  type PosthogCapture,
  type QueryCluster,
} from '@sortiva/core'
import {
  accountScope,
  findGscConnForAccount,
  findKeywordByTerm,
  findOpenOpportunity,
  insertGateDecision,
  insertMinimalOpportunity,
  insertTopic,
  productSubstanceForFamilies,
  setOpportunityTopicId,
  type Db,
  type TopicRow,
} from '@sortiva/db'
import type { GatesConfig } from '@sortiva/rules'
import { resolveStoreRules } from './store-rules'
import { runtimeLogger } from '../runtime/logging'

/**
 * The manual-add path, main §8.7: a topic the merchant typed by hand still
 * goes through Gate 1, and the answer comes back as one of the same four
 * words a real one would — proceed, proceed with a warning, converted into an
 * OPTIMIZE we already rank for, or rejected with the reason.
 *
 * This is the DB-and-contract-facing half; `runGate1`
 * (`packages/core/src/gates/gate1.ts`) is the rule itself, over plain data.
 * This file gathers that data — the stored volume for the keyword, the
 * substance inventory over the named families, the existing-target check via
 * its frozen contract — and turns Gate 1's verdict into the rows the calendar
 * and the audit trail need.
 */

export interface AdmitManualTopicDeps {
  readonly db: Db
  /** Injected rather than constructed here: the real implementation is Lane C's `DbExistingTargetCheck`, wired by whoever builds `/api/calendar/topics` (T4.2). */
  readonly existingTargetCheck: ExistingTargetCheck
  readonly now?: () => Date
  readonly logger?: Logger
  /** Optional so the gate runs without telemetry in a test. Main §14.7's `gate_decision` event — wired here by T4.2; see DECISIONS 2026-09-03 T4.2. */
  readonly capture?: Pick<PosthogCapture, 'capture'>
}

export interface AdmitManualTopicInput {
  readonly accountId: string
  /** The merchant's own words — what the calendar displays. May differ from `cluster.head`, the search term it targets. */
  readonly title: string
  /**
   * The search term this topic is for, its intent class, and which product
   * families it maps to. `addTopicRequestSchema` (M0, `packages/core/src/api/schemas.ts`)
   * collects only `{title, date, pin}` from the merchant — turning that free
   * text into a cluster (which family, which intent) is not solved anywhere
   * in the codebase yet, and is not this card's to invent; see this card's
   * final report. Whatever resolves that gap supplies this field.
   */
  readonly cluster: QueryCluster
  readonly scheduledDate: string
  readonly pinned?: boolean
  /** For the demand floor's per-locale threshold, main §8.2. */
  readonly locale?: string | null
}

export interface AdmitManualTopicResult {
  readonly outcome: 'planned' | 'planned_with_warning' | 'converted' | 'rejected'
  readonly topic: TopicRow | null
  readonly warning: Gate1ReasonCard | null
  readonly convertedToOpportunityId: string | null
  readonly rejection: Gate1ReasonCard | null
}

/**
 * Real GSC-calibrated winnability — main §9.6.4's "difficulty discounted
 * against the site's demonstrated reach" — is not built anywhere in this
 * codebase yet; it is Opportunity Engine scoring territory (main §7.6,
 * pointer map → Lane C's `packages/core/opportunities`), not Gate 1's own
 * job of enforcing a floor. Until that lands, every account is scored on the
 * same conservative constant Limited Intelligence mode already uses — never
 * lower than the truth, and behaviourally identical to today's no-GSC
 * fallback. `runGate1` takes winnability as a plain number so a real
 * calibration can be substituted here with no change to the gate itself. See
 * DECISIONS 2026-09-03 T4.1.
 */
function winnabilityFor(gates: GatesConfig): number {
  return gates.winnability.limited_intelligence_constant
}

function normaliseEntityRef(head: string): string {
  return head.trim().toLowerCase()
}

export async function admitManualTopic(
  deps: AdmitManualTopicDeps,
  input: AdmitManualTopicInput,
): Promise<AdmitManualTopicResult> {
  const log = deps.logger ?? runtimeLogger()
  const now = (deps.now ?? (() => new Date()))()
  const scope = accountScope(input.accountId)
  const fetchedAt = now.toISOString()

  // Folded into the same round trip as everything else this gate needs, so
  // honouring an operator's override costs no extra wait.
  const [keyword, connection, substanceRows, existingTargetOutcome, resolvedRules] = await Promise.all([
    findKeywordByTerm(deps.db, scope, input.cluster.head),
    findGscConnForAccount(deps.db, scope),
    productSubstanceForFamilies(deps.db, scope, input.cluster.familyIds),
    deps.existingTargetCheck.check(input.cluster, input.accountId),
    resolveStoreRules(deps.db, input.accountId, input.locale),
  ])

  const gates = resolvedRules.layer.gates
  // Says which numbers judged this topic: the repo file's, or the repo file's
  // with an override on top. See `resolveStoreRules`.
  const rulesVersion = resolvedRules.rulesVersion

  const limitedIntelligence = isLimitedIntelligence(connection ?? null)
  const substance = substanceInventory(substanceRows, gates.substance_floor)

  const gate1 = runGate1({
    cluster: input.cluster,
    monthlySearchVolume: keyword?.volume ?? null,
    pinned: input.pinned ?? false,
    manual: true,
    winnability: winnabilityFor(gates),
    limitedIntelligence,
    substance,
    existingTarget: existingTargetOutcome,
    gates,
    fetchedAt,
  })

  log.info('gate1_manual_add_evaluated', {
    account_id: input.accountId,
    outcome: gate1.outcome,
    keyword: input.cluster.head,
  })

  const outcome = manualAddOutcome(gate1)

  if (gate1.conversion) {
    const entityRef = normaliseEntityRef(gate1.conversion.url)
    const existing = await findOpenOpportunity(deps.db, scope, 'cannibalization', entityRef)
    const opportunity =
      existing ??
      (await insertMinimalOpportunity(
        deps.db,
        scope,
        {
          signalType: 'cannibalization',
          entityType: 'url',
          entityRef,
          evidenceJson: gate1.evidence,
          recommendedAction: gate1.conversion.action,
          status: 'new',
          reasonTemplateKey: gate1.reasonCard!.templateKey,
          reasonParams: gate1.reasonCard!.params,
          limitedIntelligence,
          rulesVersion,
        },
        now,
      ))
    return { outcome: 'converted', topic: null, warning: null, convertedToOpportunityId: opportunity.id, rejection: null }
  }

  // Every remaining path needs an opportunity row to satisfy
  // `topics.opportunity_id NOT NULL` — see the comment on
  // `insertMinimalOpportunity`. This one represents the manual candidate
  // itself, admitted or not.
  const candidateEntityRef = normaliseEntityRef(input.cluster.head)
  const candidateOpportunity = await insertMinimalOpportunity(
    deps.db,
    scope,
    {
      signalType: 'uncovered_commercial_query',
      entityType: 'query_cluster',
      entityRef: candidateEntityRef,
      evidenceJson: gate1.evidence,
      // This card only ever admits new-coverage manual topics (`kind: 'new'`
      // below); a manual *refresh* request is a different card's concern.
      recommendedAction: 'create',
      status: gate1.admitted ? 'scheduled' : 'blocked',
      reasonTemplateKey: gate1.reasonCard?.templateKey ?? 'gate1.admitted',
      reasonParams: gate1.reasonCard?.params ?? {},
      preconditions: gate1.admitted ? [] : [gate1.outcome],
      limitedIntelligence,
      rulesVersion,
    },
    now,
  )

  const topic = await insertTopic(
    deps.db,
    scope,
    {
      opportunityId: candidateOpportunity.id,
      title: input.title,
      targetKeyword: input.cluster.head,
      keywordCluster: null,
      intentClass: input.cluster.intentClass,
      familyIds: input.cluster.familyIds,
      kind: 'new',
      source: 'manual',
      whyLine: gate1.reasonCard?.templateKey ?? 'topic.manual_addition',
      scheduledDate: input.scheduledDate,
      pinned: input.pinned ?? false,
      state: gate1.admitted ? 'planned' : 'rejected_by_gate',
    },
    now,
  )

  await setOpportunityTopicId(deps.db, scope, candidateOpportunity.id, topic.id, now)

  await insertGateDecision(
    deps.db,
    scope,
    {
      topicId: topic.id,
      gate: 1,
      outcome: gate1.outcome,
      scoresJson: {
        reasonCard: gate1.reasonCard,
        // The same values again, one level up and under the name the read-back
        // asks for. The screens that show a held day fill the blanks in its
        // sentence from `scores_json.reason_params`; nested inside the reason
        // card they were invisible, so the sentence rendered with its blanks
        // showing. Gate 2 and Gate 3 write the same key beside their own audit.
        reason_params: gate1.reasonCard?.params ?? {},
        linkTask: gate1.linkTask,
        substance: { distinctFacts: substance.distinctFacts, contributingProducts: substance.contributingProducts, passes: substance.passes },
        winnability: winnabilityFor(gates),
        rulesVersion,
      },
      reasonUserFacing: gate1.reasonCard?.templateKey ?? null,
    },
    now,
  )

  // Main §14.7's Quality event, T4.1's gate_decisions row given a PostHog
  // capture to go with it (see DECISIONS 2026-09-03 T4.2). No per-criterion
  // scores here — Gate 1 makes no model call and has none to carry.
  deps.capture?.capture({
    event: GATE_DECISION_EVENT,
    attribution: accountAttribution(input.accountId),
    properties: { gate: 1, outcome: gate1.outcome, prompt_version: null, model_id: null },
  })

  if (gate1.admitted) {
    return {
      outcome: outcome === 'planned_with_warning' ? 'planned_with_warning' : 'planned',
      topic,
      warning: outcome === 'planned_with_warning' ? gate1.reasonCard : null,
      convertedToOpportunityId: null,
      rejection: null,
    }
  }

  return { outcome: 'rejected', topic: null, warning: null, convertedToOpportunityId: null, rejection: gate1.reasonCard }
}
