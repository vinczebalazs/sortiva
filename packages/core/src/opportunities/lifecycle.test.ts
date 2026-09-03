import { describe, expect, it } from 'vitest'
import {
  allowedTransitionsFrom,
  assertCanTransition,
  canTransition,
  InvalidOpportunityTransitionError,
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
