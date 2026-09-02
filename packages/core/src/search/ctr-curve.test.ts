import { describe, expect, it } from 'vitest'
import { rules } from '@sortiva/rules'
import { brandTokens, isBrandedQuery } from './branded'
import { expectedCtrAt, fitCtrCurve, standardCurve, type CtrSampleRow } from './ctr-curve'

/**
 * T3.3 done-when: "curve fit on fixture GSC data reproduces expected CTRs within
 * tolerance; fallback used when sample_n below config".
 *
 * The fixture is built the only way that makes "expected CTRs" a fact rather
 * than a preference: Search Console rows are generated *from* a known curve, the
 * fit is run over them, and the curve it recovers is compared back against the
 * one that produced them.
 */

const config = rules().defaults.ctr_curve

/** The curve the fixture store "really" has: 30% at position 1, falling as a power law. */
const TRUE_SCALE = 0.3
const TRUE_EXPONENT = -1.15

function trueCtrAt(position: number): number {
  return TRUE_SCALE * Math.pow(position, TRUE_EXPONENT)
}

/**
 * One row per position, with impressions spread the way a real store's are —
 * far more of them further down the page, which is what makes the weighting in
 * the fit matter.
 */
function fixtureRows(options: { impressionsAtTop?: number; upTo?: number } = {}): CtrSampleRow[] {
  const impressionsAtTop = options.impressionsAtTop ?? 4_000
  const upTo = options.upTo ?? config.max_position
  const rows: CtrSampleRow[] = []
  for (let position = 1; position <= upTo; position += 1) {
    const impressions = impressionsAtTop * position
    rows.push({
      query: `garden shears ${position}`,
      position,
      impressions,
      clicks: Math.round(impressions * trueCtrAt(position)),
    })
  }
  return rows
}

describe('fitting the store\'s own click curve', () => {
  it('recovers the curve the fixture data was generated from, within tolerance', () => {
    const fit = fitCtrCurve({ rows: fixtureRows(), config })

    expect(fit.source).toBe('fitted')
    expect(fit.fallbackReason).toBeUndefined()

    for (let position = 1; position <= config.max_position; position += 1) {
      const expected = trueCtrAt(position)
      const actual = fit.curve[String(position)]
      expect(actual).toBeDefined()
      // Within 5% relative. The rounding of clicks to whole numbers is the only
      // noise in the fixture, so anything looser would not be evidence.
      expect(Math.abs((actual as number) - expected) / expected).toBeLessThan(0.05)
    }
  })

  it('is not fooled by data from a different curve — the check would catch a rubber stamp', () => {
    // A store whose clicks fall away far more gently than the fixture curve.
    // Still a real curve, so the fit runs; if it "reproduced expected CTRs" here
    // too, the test above would be proving nothing about the arithmetic.
    const shallow = fixtureRows().map((row) => ({
      ...row,
      clicks: Math.round(row.impressions * 0.3 * Math.pow(row.position ?? 1, -0.4)),
    }))
    const fit = fitCtrCurve({ rows: shallow, config })

    expect(fit.source).toBe('fitted')
    const atMax = fit.curve[String(config.max_position)] as number
    const expected = trueCtrAt(config.max_position)
    expect(Math.abs(atMax - expected) / expected).toBeGreaterThan(0.05)
  })

  it('every position the curve claims to describe has a value', () => {
    const fit = fitCtrCurve({ rows: fixtureRows(), config })
    for (let position = 1; position <= config.max_position; position += 1) {
      expect(typeof fit.curve[String(position)]).toBe('number')
    }
  })

  it('holds the fitted curve inside the configured floor and ceiling', () => {
    // Data that would otherwise fit a curve predicting a click rate above 1 at
    // position 1: every impression clicked, everywhere.
    const perfect = fixtureRows().map((row) => ({ ...row, clicks: row.impressions }))
    const fit = fitCtrCurve({ rows: perfect, config })
    for (const value of Object.values(fit.curve)) {
      expect(value).toBeLessThanOrEqual(config.fitted_ctr_max)
      expect(value).toBeGreaterThanOrEqual(config.fitted_ctr_min)
    }
  })
})

describe('falling back to the standard curve', () => {
  it('falls back when the store has fewer impressions than the config requires', () => {
    // Scaled down so total impressions land just under the floor.
    const rows = fixtureRows()
    const total = rows.reduce((sum, row) => sum + row.impressions, 0)
    const factor = (config.min_sample_impressions - 1) / total
    const thin = rows.map((row) => ({
      ...row,
      impressions: Math.floor(row.impressions * factor),
      clicks: Math.floor(row.clicks * factor),
    }))

    const fit = fitCtrCurve({ rows: thin, config })
    expect(fit.sampleN).toBeLessThan(config.min_sample_impressions)
    expect(fit.source).toBe('standard')
    expect(fit.fallbackReason).toBe('too_few_impressions')
    expect(fit.curve).toEqual(standardCurve(config))
  })

  it('uses the store\'s own data the moment it clears the floor', () => {
    // The same shape of data, one impression over the line. Proving the floor is
    // the thing deciding, not something else about the thin fixture.
    const rows = fixtureRows()
    const total = rows.reduce((sum, row) => sum + row.impressions, 0)
    const factor = (config.min_sample_impressions + rows.length) / total
    const justEnough = rows.map((row) => ({
      ...row,
      impressions: Math.ceil(row.impressions * factor),
      clicks: Math.round(row.impressions * factor * trueCtrAt(row.position ?? 1)),
    }))

    const fit = fitCtrCurve({ rows: justEnough, config })
    expect(fit.sampleN).toBeGreaterThanOrEqual(config.min_sample_impressions)
    expect(fit.source).toBe('fitted')
  })

  it('falls back when too few distinct positions carry clicks', () => {
    const impressions = config.min_sample_impressions * 2
    const rows: CtrSampleRow[] = [
      { query: 'a', position: 1, impressions, clicks: Math.round(impressions * 0.3) },
      { query: 'b', position: 2, impressions, clicks: Math.round(impressions * 0.15) },
    ]
    const fit = fitCtrCurve({ rows, config })
    expect(fit.source).toBe('standard')
    expect(fit.fallbackReason).toBe('too_few_positions')
  })

  it('falls back rather than publishing a curve that rises down the page', () => {
    // Clicks increasing with position: noise, not a description of a store.
    const rows = fixtureRows().map((row) => ({
      ...row,
      clicks: Math.round(row.impressions * 0.01 * (row.position ?? 1)),
    }))
    const fit = fitCtrCurve({ rows, config })
    expect(fit.source).toBe('standard')
    expect(fit.fallbackReason).toBe('no_downward_trend')
  })

  it('a store with no search history at all gets the standard curve, not an empty one', () => {
    const fit = fitCtrCurve({ rows: [], config })
    expect(fit.sampleN).toBe(0)
    expect(fit.source).toBe('standard')
    expect(fit.curve).toEqual(standardCurve(config))
  })
})

describe('excluding searches for the store\'s own name', () => {
  it('leaves brand searches out of the fit, and records that it did', () => {
    const tokens = brandTokens({ domainNormalized: 'nordic-socks.dk' })
    expect(tokens).toContain('nordic')
    expect(tokens).toContain('socks')
    expect(tokens).toContain('nordicsocks')

    // A pile of brand searches that convert far better than anything else. Left
    // in, they drag the fitted curve up and every ordinary page then looks
    // under-clicked next to it.
    const branded: CtrSampleRow[] = [
      { query: 'nordic socks', position: 1, impressions: 60_000, clicks: 48_000 },
      { query: 'nordicsocks', position: 1, impressions: 40_000, clicks: 30_000 },
    ]

    const withBrand = fitCtrCurve({ rows: [...fixtureRows(), ...branded], config, brandTokens: tokens })
    const withoutBrand = fitCtrCurve({ rows: fixtureRows(), config, brandTokens: tokens })

    expect(withBrand.brandedExcluded).toBe(true)
    expect(withBrand.sampleN).toBe(withoutBrand.sampleN)
    expect(withBrand.curve).toEqual(withoutBrand.curve)
  })

  it('proves the exclusion matters by leaving it off', () => {
    const notExcluded = fitCtrCurve({
      rows: [
        ...fixtureRows(),
        { query: 'nordic socks', position: 1, impressions: 60_000, clicks: 48_000 },
        { query: 'nordicsocks', position: 1, impressions: 40_000, clicks: 30_000 },
      ],
      config,
    })
    const excluded = fitCtrCurve({
      rows: fixtureRows(),
      config,
      brandTokens: brandTokens({ domainNormalized: 'nordic-socks.dk' }),
    })

    expect(notExcluded.brandedExcluded).toBe(false)
    expect(notExcluded.curve['1']).toBeGreaterThan(excluded.curve['1'] as number)
  })

  it('records that nothing was excluded when no brand word could be worked out', () => {
    const fit = fitCtrCurve({ rows: fixtureRows(), config, brandTokens: brandTokens({}) })
    expect(fit.brandedExcluded).toBe(false)
  })
})

describe('brand words', () => {
  it('takes the brand from the claimed address and the Shopify name, dropping the suffix', () => {
    expect(brandTokens({ domainNormalized: 'kaffebar.se', shopHandle: 'kaffebar.myshopify.com' })).toEqual([
      'kaffebar',
    ])
  })

  it('refuses words that are nobody\'s brand', () => {
    expect(brandTokens({ domainNormalized: 'the-shop-online.com' })).toEqual(['theshoponline'])
  })

  it('refuses words too short to mean anything', () => {
    expect(brandTokens({ domainNormalized: 'hm.com' })).toEqual([])
  })

  it('matches whole words only, so a short brand does not swallow longer searches', () => {
    const tokens = brandTokens({ domainNormalized: 'ora-living.com' })
    expect(isBrandedQuery('ora living vase', tokens)).toBe(true)
    expect(isBrandedQuery('decoration ideas', tokens)).toBe(false)
    expect(isBrandedQuery('flora pots', tokens)).toBe(false)
  })

  it('matches a brand written as one word', () => {
    const tokens = brandTokens({ domainNormalized: 'nordic-socks.dk' })
    expect(isBrandedQuery('nordicsocks', tokens)).toBe(true)
  })

  it('nothing is branded when there are no brand words', () => {
    expect(isBrandedQuery('nordic socks', [])).toBe(false)
  })
})

describe('reading a click rate off the curve', () => {
  it('rounds a fractional position to the position it is nearest', () => {
    const curve = standardCurve(config)
    expect(expectedCtrAt(curve, 3.4)).toBe(curve['3'])
    expect(expectedCtrAt(curve, 3.6)).toBe(curve['4'])
  })

  it('answers past the end of the curve with its last position', () => {
    const curve = standardCurve(config)
    expect(expectedCtrAt(curve, 90)).toBe(curve[String(config.max_position)])
  })

  it('has no answer for a position that is not a number', () => {
    expect(expectedCtrAt(standardCurve(config), Number.NaN)).toBeNull()
  })
})
