import { describe, expect, it } from 'vitest'
import {
  DOMAIN_RELEASE_GRACE_DAYS,
  PURGE_DEADLINE_DAYS,
  RETENTION_RULES,
  domainReleaseAt,
  purgeDueAt,
  retentionCutoff,
} from './retention'

const DAY = 24 * 60 * 60 * 1000
const now = new Date('2026-09-02T01:00:00.000Z')

describe('retention policy', () => {
  it('gives every rule a plain-language reason, not a spec reference', () => {
    for (const rule of RETENTION_RULES) {
      expect(rule.why.length, `${rule.target} has no reason`).toBeGreaterThan(40)
      expect(rule.why, `${rule.target} cites a section instead of explaining`).not.toMatch(/§/)
    }
  })

  it('names each window the operating notes fix', () => {
    expect(retentionCutoff('webhook_events', now)).toEqual(new Date(now.getTime() - 30 * DAY))
    expect(retentionCutoff('notifications', now)).toEqual(new Date(now.getTime() - 90 * DAY))
    expect(retentionCutoff('email_sends', now)).toEqual(new Date(now.getTime() - 365 * DAY))
  })

  it('leaves the two self-expiring tables to their own dates', () => {
    // A cache row and a sign-in link each carry the moment they stop being
    // valid, and those two lifetimes are not the same number.
    expect(retentionCutoff('request_cache', now)).toBeUndefined()
    expect(retentionCutoff('verification_tokens', now)).toBeUndefined()
  })

  it('keeps Search Console history for sixteen months', () => {
    const cutoff = retentionCutoff('gsc_daily', now)!
    const months = (now.getTime() - cutoff.getTime()) / DAY / 30.44
    expect(months).toBeGreaterThan(15.5)
    expect(months).toBeLessThan(16.5)
  })

  it('records that the Search Console prune deletes rather than compacts', () => {
    // The spec rolls these into monthly aggregates before deleting the daily
    // rows. There is no table to roll them into, so the warning has to be
    // findable by whoever builds one.
    for (const target of ['gsc_daily', 'gsc_query_daily'] as const) {
      const rule = RETENTION_RULES.find((r) => r.target === target)!
      expect(rule.why).toMatch(/roll/i)
    }
  })

  it('frees a deleted account’s domain a week later, and erases it at the same moment', () => {
    const deletedAt = new Date('2026-09-02T12:00:00.000Z')
    expect(domainReleaseAt(deletedAt)).toEqual(new Date('2026-09-09T12:00:00.000Z'))
    // Forced, not chosen: the domain row is a child of the account row, so
    // erasing the account earlier would free the domain early.
    expect(purgeDueAt(deletedAt)).toEqual(domainReleaseAt(deletedAt))
  })

  it('erases well inside the deadline it is measured against', () => {
    expect(DOMAIN_RELEASE_GRACE_DAYS).toBeLessThan(PURGE_DEADLINE_DAYS)
  })
})
