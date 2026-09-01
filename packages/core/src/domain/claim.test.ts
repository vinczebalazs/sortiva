import { describe, expect, it } from 'vitest'
import type { AnalyticsEvent } from '../contracts/analytics'
import { claimDomain, DOMAIN_CLAIMED_EVENT, ingestionRunId } from './claim'
import { DOMAIN_ALREADY_CLAIMED_MESSAGE } from './copy'
import type { ClaimRequest, DomainClaimStore, StoreClaimResult } from './ports'

/**
 * main §5's three outcomes, and which of them is a funnel event. The store is a
 * double here; `apps/web/app/api/domain/_lib/domain.test.ts` proves the same
 * three against real SQL, where the race actually lives.
 */

const ACCOUNT = '00000000-0000-4000-8000-000000000001'

function fakeStore(result: StoreClaimResult) {
  const seen: ClaimRequest[] = []
  const store: DomainClaimStore = {
    async claimWithIngestionRun(request) {
      seen.push(request)
      return result
    },
  }
  return { store, seen }
}

function recorder() {
  const events: AnalyticsEvent[] = []
  return { events, capture: { capture: (event: AnalyticsEvent) => void events.push(event) } }
}

describe('claimDomain (main §5)', () => {
  it('claims, enqueues, and captures domain_claimed with the domain group', async () => {
    const { store, seen } = fakeStore({ kind: 'claimed', state: 'ingesting', ingestionJobId: 'job-1' })
    const telemetry = recorder()

    const result = await claimDomain(
      { store, capture: telemetry.capture },
      { accountId: ACCOUNT, domain: 'https://www.Shop.Example.co.uk/collections/all' },
    )

    expect(result).toEqual({
      kind: 'claimed',
      normalized: 'example.co.uk',
      state: 'ingesting',
      ingestionJobId: 'job-1',
    })
    // The store is handed the normalised value and a derived run id, never the
    // raw input (main §2, §14.3.2).
    expect(seen).toEqual([
      { accountId: ACCOUNT, normalized: 'example.co.uk', runId: 'claim:example.co.uk' },
    ])
    expect(telemetry.events).toEqual([
      {
        event: DOMAIN_CLAIMED_EVENT,
        attribution: { kind: 'account', accountId: ACCOUNT, domain: 'example.co.uk' },
      },
    ])
  })

  it('is silent for a returning merchant: same answer, no second funnel event', async () => {
    const { store } = fakeStore({ kind: 'already_yours', state: 'ingesting', ingestionJobId: 'job-1' })
    const telemetry = recorder()

    const result = await claimDomain(
      { store, capture: telemetry.capture },
      { accountId: ACCOUNT, domain: 'example.co.uk' },
    )

    expect(result.kind).toBe('already_yours')
    expect(result).toMatchObject({ ingestionJobId: 'job-1', state: 'ingesting' })
    // main §14.7 — counting a re-visit as a claim would inflate the funnel the
    // same way counting every sign-in as a signup would.
    expect(telemetry.events).toEqual([])
  })

  it('returns main §5 verbatim when another account holds the domain', async () => {
    const { store } = fakeStore({ kind: 'taken_by_other' })
    const telemetry = recorder()

    const result = await claimDomain(
      { store, capture: telemetry.capture },
      { accountId: ACCOUNT, domain: 'taken.com' },
    )

    expect(result).toEqual({
      kind: 'taken_by_other',
      normalized: 'taken.com',
      message: DOMAIN_ALREADY_CLAIMED_MESSAGE,
    })
    expect(telemetry.events).toEqual([])
  })

  it('names the domain this account already holds (invariant 1)', async () => {
    const { store } = fakeStore({ kind: 'account_has_other_domain', current: 'first.com' })

    const result = await claimDomain({ store }, { accountId: ACCOUNT, domain: 'second.com' })

    expect(result.kind).toBe('account_has_other_domain')
    expect(result).toMatchObject({ current: 'first.com' })
    if (result.kind === 'account_has_other_domain') {
      expect(result.message).toContain('first.com')
    }
  })

  it('rejects an unusable address before touching the store', async () => {
    const { store, seen } = fakeStore({ kind: 'claimed', state: 'ingesting', ingestionJobId: 'x' })

    const result = await claimDomain({ store }, { accountId: ACCOUNT, domain: 'not a website' })

    expect(result.kind).toBe('invalid_domain')
    expect(seen).toEqual([])
  })

  it('derives the run id from the domain, so a retry cannot start a second run', () => {
    expect(ingestionRunId('example.co.uk')).toBe(ingestionRunId('example.co.uk'))
    expect(ingestionRunId('example.co.uk')).not.toBe(ingestionRunId('other.com'))
  })
})
