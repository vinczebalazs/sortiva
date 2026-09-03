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

  it('rejects every status jumping straight to executing except from scheduled', () => {
    for (const from of ALL_STATUSES) {
      if (from === 'scheduled') continue
      expect(canTransition(from, 'executing')).toBe(false)
    }
  })

  it('assertCanTransition throws a named error on an illegal move, and nothing on a legal one', () => {
    expect(() => assertCanTransition('completed', 'new')).toThrow(InvalidOpportunityTransitionError)
    expect(() => assertCanTransition('new', 'accepted')).not.toThrow()
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
