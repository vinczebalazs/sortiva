import { describe, expect, it } from 'vitest'
import {
  assertEntitled,
  billingGate,
  EntitlementInactiveError,
  isEntitled,
  type LocalSubscription,
} from './entitlement'
import { ENTITLEMENT_INACTIVE_CODE } from '../api/errors'
import { PAYMENT_FAILED_BANNER } from './copy'

/**
 * Constitution invariant 16 — "Billing state gates generation/publishing only —
 * **read access is never revoked**."
 */

function subscription(overrides: Partial<LocalSubscription> = {}): LocalSubscription {
  return {
    status: 'active',
    cancelAtPeriodEnd: false,
    currentPeriodEnd: new Date('2026-10-01T00:00:00Z'),
    ...overrides,
  }
}

describe('entitlement is the local row and nothing else (main §4.2)', () => {
  it('is entitled only while the status is active', () => {
    expect(isEntitled(subscription({ status: 'active' }))).toBe(true)
    expect(isEntitled(subscription({ status: 'past_due' }))).toBe(false)
    expect(isEntitled(subscription({ status: 'canceled' }))).toBe(false)
    expect(isEntitled(subscription({ status: 'incomplete_expired' }))).toBe(false)
    expect(isEntitled(null)).toBe(false)
  })

  it('keeps read access open in every billing state', () => {
    const states: LocalSubscription['status'][] = [
      'active',
      'past_due',
      'canceled',
      'incomplete_expired',
    ]
    for (const status of states) {
      expect(billingGate(subscription({ status })).readAllowed).toBe(true)
    }
    expect(billingGate(null).readAllowed).toBe(true)
  })

  it('pauses generation and publishing the moment a payment fails (main §4.2 dunning)', () => {
    const gate = billingGate(subscription({ status: 'past_due' }))
    expect(gate.generationAllowed).toBe(false)
    expect(gate.publishingAllowed).toBe(false)
    expect(gate.banner).toEqual({
      kind: 'payment_failed',
      message: PAYMENT_FAILED_BANNER,
      dismissible: false,
    })
  })

  it('runs entitlement to period end when the merchant cancels (main §14.6)', () => {
    const endsAt = new Date('2026-10-01T00:00:00Z')
    const gate = billingGate(subscription({ cancelAtPeriodEnd: true, currentPeriodEnd: endsAt }))
    expect(gate.generationAllowed).toBe(true)
    expect(gate.publishingAllowed).toBe(true)
    expect(gate.banner).toEqual({ kind: 'ending', endsAt })
  })

  it('stops generation once the period actually ended', () => {
    const gate = billingGate(subscription({ status: 'canceled', cancelAtPeriodEnd: true }))
    expect(gate.generationAllowed).toBe(false)
    expect(gate.publishingAllowed).toBe(false)
    expect(gate.readAllowed).toBe(true)
    expect(gate.banner).toEqual({ kind: 'canceled' })
  })

  it('an account that never checked out is simply not entitled, with no banner', () => {
    const gate = billingGate(null)
    expect(gate.status).toBe('none')
    expect(gate.generationAllowed).toBe(false)
    expect(gate.banner).toEqual({ kind: 'none' })
  })
})

describe('refusing work is a 402 with its own code (DECISIONS T0.7)', () => {
  it('throws only when the row is not active', () => {
    expect(() => assertEntitled(subscription())).not.toThrow()
    let thrown: unknown
    try {
      assertEntitled(subscription({ status: 'past_due' }))
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(EntitlementInactiveError)
    expect((thrown as EntitlementInactiveError).httpStatus).toBe(402)
    expect((thrown as EntitlementInactiveError).code).toBe(ENTITLEMENT_INACTIVE_CODE)
  })
})
