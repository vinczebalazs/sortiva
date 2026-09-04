import { describe, expect, it } from 'vitest'
import {
  allowedTransitionsFrom,
  assertCanTransition,
  canTransition,
  InvalidOpportunityTransitionError,
  reconcileStatusWithPreconditions,
} from './lifecycle'
import type { OpportunityStatus } from '../contracts/opportunities'

const ALL_STATUSES: readonly OpportunityStatus[] = [
  'new',
  'accepted',
  'scheduled',
  'executing',
  'completed',
  'dismissed',
  'blocked',
  'expired',
]

describe('the opportunity status machine (main §7.9)', () => {
  it('walks the full happy path: new → accepted → scheduled → executing → completed', () => {
    expect(canTransition('new', 'accepted')).toBe(true)
    expect(canTransition('accepted', 'scheduled')).toBe(true)
    expect(canTransition('scheduled', 'executing')).toBe(true)
    expect(canTransition('executing', 'completed')).toBe(true)
  })

  it('lets any open status expire, and expiry is terminal', () => {
    for (const open of ['new', 'accepted', 'scheduled', 'executing', 'blocked'] as const) {
      expect(canTransition(open, 'expired')).toBe(true)
    }
    expect(allowedTransitionsFrom('expired')).toEqual([])
  })

  it('completed never moves again — the learning loop needs it to stay put', () => {
    expect(allowedTransitionsFrom('completed')).toEqual([])
  })

  it('a blocked row returns to new once its precondition resolves', () => {
    expect(canTransition('blocked', 'new')).toBe(true)
    expect(canTransition('blocked', 'accepted')).toBe(true)
  })

  it('a dismissed row can only be undone back to new — never straight to accepted', () => {
    expect(allowedTransitionsFrom('dismissed')).toEqual(['new'])
    expect(canTransition('dismissed', 'accepted')).toBe(false)
  })

  it('only lets work start from a status somebody can actually start it from', () => {
    // The calendar starts a scheduled topic; the merchant starts an OPTIMIZE
    // from their list. Nothing else may put a row into `executing` — in
    // particular not `blocked`, which is a row we have told the merchant we are
    // holding back.
    const canStart: readonly OpportunityStatus[] = ['new', 'accepted', 'scheduled']
    for (const from of ALL_STATUSES) {
      expect(canTransition(from, 'executing')).toBe(canStart.includes(from))
    }
  })

  it('assertCanTransition throws a named error on an illegal move, and nothing on a legal one', () => {
    expect(() => assertCanTransition('completed', 'new')).toThrow(InvalidOpportunityTransitionError)
    expect(() => assertCanTransition('new', 'accepted')).not.toThrow()
  })
})

/**
 * The improve-this-page feature moves an opportunity's status four times, and
 * for a while this graph admitted none of them: it had been written around the
 * calendar, which is the only other thing that moves these rows, and nothing
 * noticed because the database helper that performs the moves does not consult
 * the graph. `T6.3` reads the graph as truth, so the two have to agree.
 *
 * Each step below names the code that performs it. If one of those moves ever
 * changes, this walk is what should fail.
 */
describe('the improve-this-page (OPTIMIZE) lifecycle, against the graph', () => {
  const walk = (steps: readonly (readonly [OpportunityStatus, OpportunityStatus])[]): void => {
    for (const [from, to] of steps) assertCanTransition(from, to)
  }

  it('accepts a first press: the row is offered, generated, and marked applied', () => {
    walk([
      // The merchant presses the button on a row nobody has touched
      // (`makeGenerateRecommendationHandler`, from: ['new','accepted']).
      ['new', 'executing'],
      // Generation succeeds and hands the row back (`generate.ts`,
      // from: ['executing'], to: 'accepted').
      ['executing', 'accepted'],
      // The merchant says they applied it (`markOpportunityApplied`).
      ['accepted', 'completed'],
    ])
  })

  it('accepts the same walk from the other entry point the button admits', () => {
    walk([
      ['accepted', 'executing'],
      ['executing', 'accepted'],
      ['accepted', 'completed'],
    ])
  })

  it('accepts the branch where our own checks reject the recommendation', () => {
    // `failValidation` returns the row to `accepted` on exactly the same edge,
    // so the merchant can press again rather than being stranded.
    walk([['accepted', 'executing'], ['executing', 'accepted'], ['accepted', 'executing']])
  })

  it('accepts a press that is blocked by a technical precondition and later resolves', () => {
    walk([
      ['new', 'blocked'],
      // The next scan finds the precondition cleared; an OPTIMIZE goes back to
      // `new` rather than `accepted` (`reconcileStatusWithPreconditions`).
      ['blocked', 'new'],
      ['new', 'executing'],
      ['executing', 'accepted'],
      ['accepted', 'completed'],
    ])
  })

  it('accepts the applied answer from every status the row can still be open in', () => {
    // `markOpportunityApplied` is guarded on "still open" and nothing narrower,
    // so the graph says the same rather than a subset of it.
    for (const open of ['new', 'accepted', 'scheduled', 'executing', 'blocked'] as const) {
      expect(canTransition(open, 'completed')).toBe(true)
    }
  })

  it('still refuses a move the code never makes — so the walk above is not vacuous', () => {
    // Same shape as the walks, one step swapped for a move nothing performs.
    // If the graph had simply been opened up, this would pass too.
    expect(() => walk([['new', 'blocked'], ['blocked', 'executing']])).toThrow(
      InvalidOpportunityTransitionError,
    )
    expect(canTransition('blocked', 'executing')).toBe(false)

    // And the boundaries either side of the OPTIMIZE walk hold: a finished row
    // cannot be reopened for another generation, a row we are generating cannot
    // jump onto the calendar, and a merchant's "not interested" is not undone
    // into work.
    expect(canTransition('completed', 'executing')).toBe(false)
    expect(canTransition('executing', 'scheduled')).toBe(false)
    expect(canTransition('dismissed', 'executing')).toBe(false)
    expect(canTransition('expired', 'completed')).toBe(false)
  })
})

describe('reconcileStatusWithPreconditions — the T3.6 scheduled-audit HIGH finding, closed (main §7.9)', () => {
  it('blocks an auto-accepted REFRESH the instant a technical blocker appears on re-detection', () => {
    expect(reconcileStatusWithPreconditions('accepted', 'REFRESH', false)).toEqual({ to: 'blocked' })
  })

  it('blocks a new (never-accepted) OPTIMIZE/FIX row the same way', () => {
    expect(reconcileStatusWithPreconditions('new', 'OPTIMIZE', false)).toEqual({ to: 'blocked' })
  })

  it('leaves an accepted row alone while its preconditions stay clear', () => {
    expect(reconcileStatusWithPreconditions('accepted', 'CREATE', true)).toBeNull()
  })

  it('unblocks back to accepted for CREATE/REFRESH once the precondition clears — the promised "re-checked at next scan"', () => {
    expect(reconcileStatusWithPreconditions('blocked', 'CREATE', true)).toEqual({ to: 'accepted' })
    expect(reconcileStatusWithPreconditions('blocked', 'REFRESH', true)).toEqual({ to: 'accepted' })
  })

  it('unblocks back to new for OPTIMIZE/FIX/HOLD once the precondition clears', () => {
    expect(reconcileStatusWithPreconditions('blocked', 'OPTIMIZE', true)).toEqual({ to: 'new' })
    expect(reconcileStatusWithPreconditions('blocked', 'FIX', true)).toEqual({ to: 'new' })
    expect(reconcileStatusWithPreconditions('blocked', 'HOLD', true)).toEqual({ to: 'new' })
  })

  it('leaves a still-blocked row alone while its precondition is still open', () => {
    expect(reconcileStatusWithPreconditions('blocked', 'CREATE', false)).toBeNull()
  })

  it('never touches scheduled, executing, completed, dismissed or expired — the calendar owns those', () => {
    for (const status of ['scheduled', 'executing', 'completed', 'dismissed', 'expired'] as const) {
      expect(reconcileStatusWithPreconditions(status, 'CREATE', false)).toBeNull()
      expect(reconcileStatusWithPreconditions(status, 'CREATE', true)).toBeNull()
    }
  })
})
