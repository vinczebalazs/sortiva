import { describe, expect, it } from 'vitest'
import { billingGate } from '../billing/entitlement'
import { lifecycleGate } from './gate'

const active = billingGate({ status: 'active', cancelAtPeriodEnd: false, currentPeriodEnd: null })
const pastDue = billingGate({ status: 'past_due', cancelAtPeriodEnd: false, currentPeriodEnd: null })

describe('what an account is allowed to do', () => {
  it('lets a paid-up account with no toggles set do everything', () => {
    const gate = lifecycleGate({ billing: active, vacationMode: false, deletionRequestedAt: null })
    expect(gate).toEqual({
      generationAllowed: true,
      publishingAllowed: true,
      catalogSyncAllowed: true,
      searchReportingAllowed: true,
      readAllowed: true,
      stoppedBy: [],
    })
  })

  it('vacation mode stops writing and leaves reading the store alone', () => {
    const gate = lifecycleGate({ billing: active, vacationMode: true, deletionRequestedAt: null })
    expect(gate.generationAllowed).toBe(false)
    expect(gate.publishingAllowed).toBe(false)
    // The whole point of the toggle: a merchant comes back to current data
    // rather than a month-shaped hole, which is what a revoked token would give
    // them.
    expect(gate.catalogSyncAllowed).toBe(true)
    expect(gate.searchReportingAllowed).toBe(true)
    expect(gate.readAllowed).toBe(true)
    expect(gate.stoppedBy).toEqual(['vacation'])
  })

  it('an unpaid account keeps read access, which billing never takes away', () => {
    const gate = lifecycleGate({ billing: pastDue, vacationMode: false, deletionRequestedAt: null })
    expect(gate.generationAllowed).toBe(false)
    expect(gate.publishingAllowed).toBe(false)
    expect(gate.readAllowed).toBe(true)
    expect(gate.catalogSyncAllowed).toBe(true)
    expect(gate.stoppedBy).toEqual(['billing'])
  })

  it('a requested deletion stops everything, reading included', () => {
    const gate = lifecycleGate({
      billing: active,
      vacationMode: false,
      deletionRequestedAt: new Date('2026-09-02T00:00:00Z'),
    })
    expect(gate).toEqual({
      generationAllowed: false,
      publishingAllowed: false,
      catalogSyncAllowed: false,
      searchReportingAllowed: false,
      readAllowed: false,
      stoppedBy: ['deletion_requested'],
    })
  })

  it('names every reason at once, so fixing one does not look like fixing all', () => {
    const gate = lifecycleGate({ billing: pastDue, vacationMode: true, deletionRequestedAt: null })
    expect(gate.stoppedBy).toEqual(['billing', 'vacation'])
  })
})
