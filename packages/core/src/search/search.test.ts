import { describe, expect, it } from 'vitest'
import { annotateProperties, parseGscProperty, propertyMatchesClaimedDomain } from './property'
import { isLimitedIntelligence, searchConsoleConnectionState } from './connection'
import { backfillRanges, dailySyncRange, nextRange, rangeKey } from './windows'
import { toPageDailyRows, toQueryDailyRows } from './rows'
import type { GscSearchAnalyticsRow } from '../contracts/gsc'

describe('reading a Search Console property', () => {
  it('accepts both kinds Google offers', () => {
    expect(parseGscProperty('sc-domain:example.com')).toEqual({
      kind: 'domain',
      host: 'example.com',
    })
    expect(parseGscProperty('https://www.example.com/')).toEqual({
      kind: 'url_prefix',
      host: 'example.com',
    })
    expect(parseGscProperty('https://shop.example.com/eu/')).toEqual({
      kind: 'url_prefix',
      host: 'shop.example.com',
    })
  })

  it('refuses anything it cannot read a host out of', () => {
    expect(parseGscProperty('')).toBeNull()
    expect(parseGscProperty('   ')).toBeNull()
    expect(parseGscProperty('example.com')).toBeNull()
    expect(parseGscProperty('ftp://example.com/')).toBeNull()
    expect(parseGscProperty('sc-domain:')).toBeNull()
  })
})

describe('the property has to be the store we claimed', () => {
  it('accepts the claimed domain and anything under it', () => {
    expect(propertyMatchesClaimedDomain('sc-domain:example.com', 'example.com')).toBe(true)
    expect(propertyMatchesClaimedDomain('https://www.example.com/', 'example.com')).toBe(true)
    expect(propertyMatchesClaimedDomain('https://shop.example.com/', 'example.com')).toBe(true)
    expect(propertyMatchesClaimedDomain('sc-domain:blog.example.com', 'example.com')).toBe(true)
  })

  it('rejects somebody else’s site, including one that merely ends the same way', () => {
    expect(propertyMatchesClaimedDomain('sc-domain:other.com', 'example.com')).toBe(false)
    // The trap this check exists for: `notexample.com` ends with `example.com`
    // as a string, and is a different business entirely.
    expect(propertyMatchesClaimedDomain('sc-domain:notexample.com', 'example.com')).toBe(false)
    expect(propertyMatchesClaimedDomain('https://example.com.attacker.net/', 'example.com')).toBe(
      false,
    )
  })

  it('handles a store on a shared platform, where the claim is one level deeper', () => {
    expect(propertyMatchesClaimedDomain('sc-domain:acme.myshopify.com', 'acme.myshopify.com')).toBe(
      true,
    )
    expect(
      propertyMatchesClaimedDomain('sc-domain:other.myshopify.com', 'acme.myshopify.com'),
    ).toBe(false)
  })

  it('flags every property in the picker so a mismatch is visible before submitting', () => {
    expect(
      annotateProperties(
        [
          { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' },
          { siteUrl: 'https://clients-site.com/', permissionLevel: 'siteFullUser' },
        ],
        'example.com',
      ),
    ).toEqual([
      { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner', matchesClaimedDomain: true },
      {
        siteUrl: 'https://clients-site.com/',
        permissionLevel: 'siteFullUser',
        matchesClaimedDomain: false,
      },
    ])
  })
})

describe('Limited Intelligence is derived, never stored', () => {
  it('is on with no connection at all', () => {
    expect(isLimitedIntelligence(null)).toBe(true)
    expect(searchConsoleConnectionState(null)).toBe('none')
  })

  it('is still on once Google has granted access but no property is chosen', () => {
    const halfway = { property: '', invalidatedAt: null }
    expect(isLimitedIntelligence(halfway)).toBe(true)
    expect(searchConsoleConnectionState(halfway)).toBe('none')
  })

  it('turns off the moment a property is chosen, with nothing to write', () => {
    const connected = { property: 'sc-domain:example.com', invalidatedAt: null }
    expect(isLimitedIntelligence(connected)).toBe(false)
    expect(searchConsoleConnectionState(connected)).toBe('connected')
  })

  it('does not come back when the grant dies — the history we synced is still there', () => {
    const broken = { property: 'sc-domain:example.com', invalidatedAt: new Date() }
    expect(isLimitedIntelligence(broken)).toBe(false)
    expect(searchConsoleConnectionState(broken)).toBe('broken')
  })
})

describe('which days to ask for', () => {
  const today = new Date('2026-09-02T09:00:00Z')

  it('never asks for days Google has not finished counting', () => {
    const range = dailySyncRange({ today, lookbackDays: 7, dataLagDays: 2 })
    expect(range).toEqual({ startDate: '2026-08-25', endDate: '2026-08-31' })
  })

  it('re-asks for recent days so late revisions overwrite what we stored', () => {
    const range = dailySyncRange({ today, lookbackDays: 7, dataLagDays: 2 })
    const days =
      (Date.parse(`${range.endDate}T00:00:00Z`) - Date.parse(`${range.startDate}T00:00:00Z`)) /
        86_400_000 +
      1
    expect(days).toBe(7)
  })

  it('splits the import into chunks, newest first, covering the whole window exactly once', () => {
    const ranges = backfillRanges({ today, backfillMonths: 16, chunkDays: 30, dataLagDays: 2 })

    expect(ranges[0]).toEqual({ startDate: '2026-08-02', endDate: '2026-08-31' })
    // Sixteen months before 31 August is the 31st of a month with 30 days, so
    // the earliest day lands on 1 May rather than 30 April. Overshooting would
    // buy nothing: Google serves no more than sixteen months either way.
    expect(ranges.at(-1)?.startDate).toBe('2025-05-01')
    expect(ranges.at(-1)?.endDate).toBe('2025-05-08')

    for (let i = 1; i < ranges.length; i += 1) {
      const previousStart = Date.parse(`${ranges[i - 1]!.startDate}T00:00:00Z`)
      const thisEnd = Date.parse(`${ranges[i]!.endDate}T00:00:00Z`)
      expect(thisEnd).toBe(previousStart - 86_400_000)
    }
  })

  it('resumes at the first chunk not already committed', () => {
    const ranges = backfillRanges({ today, backfillMonths: 16, chunkDays: 30, dataLagDays: 2 })
    expect(nextRange(ranges, undefined)).toEqual(ranges[0])

    const afterTwo = { completed: [rangeKey(ranges[0]!), rangeKey(ranges[1]!)], rowsWritten: 40 }
    expect(nextRange(ranges, afterTwo)).toEqual(ranges[2])

    const all = { completed: ranges.map(rangeKey), rowsWritten: 999 }
    expect(nextRange(ranges, all)).toBeUndefined()
  })
})

describe('turning Google’s report into our two tables', () => {
  const row = (over: Partial<GscSearchAnalyticsRow>): GscSearchAnalyticsRow => ({
    date: '2026-08-31',
    page: 'https://example.com/a',
    query: 'trail shoes',
    device: 'DESKTOP',
    country: 'usa',
    clicks: 1,
    impressions: 10,
    position: 5,
    ...over,
  })

  it('merges rows that share all four dimensions instead of colliding on insert', () => {
    const merged = toQueryDailyRows([
      row({ clicks: 1, impressions: 10, position: 4 }),
      row({ clicks: 2, impressions: 30, position: 8 }),
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0]!.clicks).toBe(3)
    expect(merged[0]!.impressions).toBe(40)
    // Weighted by impressions: (4×10 + 8×30) / 40 = 7, not the flat average of 6.
    expect(merged[0]!.position).toBeCloseTo(7)
  })

  it('rolls page totals up from the same rows rather than buying them twice', () => {
    const queries = toQueryDailyRows([
      row({ query: 'trail shoes', clicks: 1, impressions: 10, position: 4 }),
      row({ query: 'trail running shoes', clicks: 5, impressions: 30, position: 8 }),
      row({ page: 'https://example.com/b', clicks: 0, impressions: 2, position: 20 }),
    ])
    const pages = toPageDailyRows(queries)

    const a = pages.find((p) => p.page === 'https://example.com/a')!
    expect(a.clicks).toBe(6)
    expect(a.impressions).toBe(40)
    expect(a.position).toBeCloseTo(7)

    const b = pages.find((p) => p.page === 'https://example.com/b')!
    expect(b.impressions).toBe(2)
  })

  it('leaves position empty when nothing was ever shown, rather than recording first place', () => {
    const pages = toPageDailyRows(toQueryDailyRows([row({ clicks: 0, impressions: 0, position: 0 })]))
    expect(pages[0]!.position).toBeNull()
  })
})
