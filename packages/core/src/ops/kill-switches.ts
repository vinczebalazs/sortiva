/**
 * The brakes an operator pulls by hand, and the vocabulary every automatic
 * brake raises.
 *
 * A kill switch is a row in `ops_flags` saying "stop doing this", with who
 * raised it, why, and whether a person or the product raised it. Nothing here
 * touches a database: this file is the *vocabulary* — which switches exist,
 * what each one stops, who may lower it — so that the same answers hold in the
 * job runtime, in a repository and in an operator script without three copies
 * of the policy.
 *
 * Two rules run through all of it:
 *
 * - **Reading is never taken away.** Every switch below stops work the product
 *   does *for* a merchant. None of them closes a screen, hides an article, or
 *   revokes a login. A merchant whose account is paused can still read
 *   everything they could read a minute earlier.
 * - **A switch pauses; it never lowers the bar.** There is no flag here that
 *   makes the product carry on with a cheaper model, staler data or a skipped
 *   check. Pausing is the whole of the degraded behaviour.
 */

import {
  ACCOUNT_PAUSED_FLAG as ACCOUNT_GENERATION_PAUSED_FLAG,
  ALL_WORK_PAUSED_FLAG,
  ENRICHMENT_PAUSED_FLAG,
} from './spend-caps'

export { ACCOUNT_GENERATION_PAUSED_FLAG }

/**
 * The switch that pauses the logged-out preview, named here rather than
 * imported from the preview module.
 *
 * **This literal is deliberately a second copy.** Nothing outside the preview
 * may import from it — that ban is what stops throwaway preview output leaking
 * into the real pipeline, and a test enforces it across the whole workspace.
 * The rule is worth more than the duplication, so the catalogue below names the
 * switch itself. `kill-switches.test.ts` reads the preview module as *text* and
 * fails if the two ever stop agreeing, which is a pin without a dependency.
 */
const PREVIEW_PAUSED_FLAG = 'global.pause_preview'

/** Which flags an operator may raise or lower by hand, and what each stops. */
export interface KillSwitchDefinition {
  readonly flag: string
  /** `global` flags have no account; `account` flags name one. */
  readonly scope: 'global' | 'account'
  /** What stops while this is up, in a sentence an operator can act on. */
  readonly stops: string
  /**
   * Whether lowering it needs a second operator. True on every global switch:
   * a global flag was raised because something was wrong for everybody, and
   * one person deciding alone that it is over is how an incident gets closed
   * because it was inconvenient.
   */
  readonly resetNeedsTwoOperators: boolean
}

/** Stops publishing everywhere while leaving generation running: drafts still get made, none of them go out. */
export const PUBLISHING_PAUSED_FLAG = 'global.pause_publishing'

/** The same, for one store. */
export const ACCOUNT_PUBLISHING_PAUSED_FLAG = 'account.pause_publishing'

/**
 * The two paid call types a merchant can trigger on demand, each with its own
 * per-account daily ceiling. Crossing one pauses that call type for that store
 * and nothing else — the daily article keeps being written.
 */
export const ACCOUNT_INTENT_GAP_PAUSED_FLAG = 'account.pause_intent_gap'
export const ACCOUNT_OPTIMIZE_PAUSED_FLAG = 'account.pause_optimize'

export const KILL_SWITCHES: readonly KillSwitchDefinition[] = [
  {
    flag: ALL_WORK_PAUSED_FLAG,
    scope: 'global',
    stops: 'every account\'s pipeline work: catalogue reads, distillation, enrichment, generation.',
    resetNeedsTwoOperators: true,
  },
  {
    flag: PUBLISHING_PAUSED_FLAG,
    scope: 'global',
    stops: 'publishing to every store. Drafts are still written and still reviewed; none of them go out.',
    resetNeedsTwoOperators: true,
  },
  {
    flag: ENRICHMENT_PAUSED_FLAG,
    scope: 'global',
    stops: 'paid search-data reads for everybody. Cached answers are still served.',
    resetNeedsTwoOperators: true,
  },
  {
    flag: PREVIEW_PAUSED_FLAG,
    scope: 'global',
    stops:
      'fresh work behind the logged-out preview. Cache hits are answered as normal and a miss gets the generic card.',
    resetNeedsTwoOperators: true,
  },
  {
    flag: ACCOUNT_GENERATION_PAUSED_FLAG,
    scope: 'account',
    stops: 'one store\'s pipeline work. Every screen that store could read, it can still read.',
    resetNeedsTwoOperators: false,
  },
  {
    flag: ACCOUNT_PUBLISHING_PAUSED_FLAG,
    scope: 'account',
    stops: 'publishing to one store, while its drafts keep being written.',
    resetNeedsTwoOperators: false,
  },
  {
    flag: ACCOUNT_INTENT_GAP_PAUSED_FLAG,
    scope: 'account',
    stops: 'one store\'s intent-gap analyses for the rest of the day. Nothing else about that store changes.',
    resetNeedsTwoOperators: false,
  },
  {
    flag: ACCOUNT_OPTIMIZE_PAUSED_FLAG,
    scope: 'account',
    stops: 'one store\'s OPTIMIZE generations for the rest of the day. Nothing else about that store changes.',
    resetNeedsTwoOperators: false,
  },
]

export function killSwitch(flag: string): KillSwitchDefinition | undefined {
  return KILL_SWITCHES.find((s) => s.flag === flag)
}

/**
 * Whoever or whatever raised a switch. `auto` is the product itself, and is
 * never allowed to lower one — an automatic trip means a person has to look at
 * why it fired, so nothing automatic may decide the answer is "it stopped".
 */
export const AUTOMATIC_ACTOR = 'auto'

export type ResetRefusal =
  | { readonly ok: false; readonly code: 'unknown_flag'; readonly detail: string }
  | { readonly ok: false; readonly code: 'second_operator_missing'; readonly detail: string }
  | { readonly ok: false; readonly code: 'same_operator_twice'; readonly detail: string }
  | { readonly ok: false; readonly code: 'automatic_actor'; readonly detail: string }

export type ResetReview =
  | {
      readonly ok: true
      /** What goes in `reset_by`: both names, so the record shows who agreed. */
      readonly resetBy: string
    }
  | ResetRefusal

/**
 * **Four eyes.** A global switch is lowered by two named operators, not one.
 *
 * The check is a *policy* rather than a workflow: both names arrive on the same
 * command and both are recorded. There is no "proposed, awaiting approval"
 * state, because holding one would need a column `ops_flags` does not have —
 * see the journal entry for this card. What it does buy is that no single
 * person can lower a global switch on their own authority and no record of the
 * second person is optional, which is the property the rule exists for.
 *
 * An account switch needs one operator. It was raised about one store, and the
 * blast radius of lowering it wrongly is that store.
 */
export function reviewReset(input: {
  flag: string
  operator: string
  /** Required on a global flag; ignored on an account flag. */
  secondOperator?: string | undefined
}): ResetReview {
  const definition = killSwitch(input.flag)
  if (!definition) {
    return {
      ok: false,
      code: 'unknown_flag',
      detail: `"${input.flag}" is not a switch this product raises. Nothing was changed.`,
    }
  }

  const first = input.operator.trim()
  const second = input.secondOperator?.trim() ?? ''

  if (first === '' || first === AUTOMATIC_ACTOR) {
    return {
      ok: false,
      code: 'automatic_actor',
      detail: 'A switch is lowered by a named person. The product never lowers its own.',
    }
  }

  if (!definition.resetNeedsTwoOperators) return { ok: true, resetBy: first }

  if (second === '' || second === AUTOMATIC_ACTOR) {
    return {
      ok: false,
      code: 'second_operator_missing',
      detail: `${input.flag} stopped work for everybody, so two named operators have to agree it is over.`,
    }
  }
  if (second === first) {
    return {
      ok: false,
      code: 'same_operator_twice',
      detail: 'The second operator has to be someone else.',
    }
  }
  return { ok: true, resetBy: `${first} + ${second}` }
}

/**
 * The incident record.
 *
 * There is no incidents table and this card may not add one, so the incident
 * *is* the flag row: it already carries what raised it, why, when, and whether
 * it has been lowered — and because an automatic trip never lowers itself, an
 * open incident is exactly an active flag with `tripped_by = 'auto'`. This
 * function is the reading of those columns as an incident, so the shape is
 * written once rather than re-derived at each place that lists them.
 */
export interface Incident {
  readonly flag: string
  readonly scope: 'global' | 'account'
  readonly accountId: string | null
  readonly raisedBy: string
  readonly reason: string
  readonly automatic: boolean
  readonly raisedAt: Date
  /** Null while the incident is open. Automatic trips are open until a person closes them. */
  readonly closedAt: Date | null
  readonly closedBy: string | null
}

export function incidentFrom(row: {
  flag: string
  scope: 'global' | 'account'
  accountId: string | null
  actor: string
  reason: string
  trippedBy: string
  createdAt: Date
  resetAt: Date | null
  resetBy: string | null
}): Incident {
  return {
    flag: row.flag,
    scope: row.scope,
    accountId: row.accountId,
    raisedBy: row.actor,
    reason: row.reason,
    automatic: row.trippedBy === AUTOMATIC_ACTOR,
    raisedAt: row.createdAt,
    closedAt: row.resetAt,
    closedBy: row.resetBy,
  }
}

/** The analytics event name for a trip. Telemetry only — the flag row is what enforces. */
export const KILL_SWITCH_TRIPPED_EVENT = 'kill_switch_tripped'
