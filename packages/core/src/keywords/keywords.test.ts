import { describe, expect, it } from 'vitest'
import { isBlocklistedDomain } from './blocklist'
import { renderSeedBrief } from './brief'
import { rankCompetitorCandidates } from './candidates'
import { deriveSeedKeywords, pickDraftKeywords } from './discover'
import { SEED_KEYWORDS_SCHEMA } from './schema'
import { validateCompetitorDomain, validateKeywordTerm } from './validate'
import type { FamilyBrief } from '../persona/brief'
import type { KeywordMetric } from '../contracts/seo'
import type { LlmClient, LlmRequest, LlmResult } from '../contracts/llm'

/** A model that answers with whatever it is told to, recording what it was asked. */
class StubLlmClient implements LlmClient {
  readonly requests: LlmRequest[] = []

  constructor(private readonly answer: Record<string, unknown>) {}

  async complete<T>(request: LlmRequest): Promise<LlmResult<T>> {
    this.requests.push(request)
    return {
      output: this.answer as T,
      text: JSON.stringify(this.answer),
      modelId: 'claude-sonnet-5',
      promptVersion: request.promptVersion,
      cacheHit: false,
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      usdCost: 0.0007,
      latencyMs: 900,
      attempts: 1,
    }
  }
}

const FACTS = {
  material: 'merino wool',
  dimensions: null,
  weight: null,
  capacity: null,
  care: null,
  origin: null,
  compatibility: [],
  use_cases_stated: ['trail running'],
  certifications: [],
  verifiable_claims: [],
  price_range: null,
} as unknown as FamilyBrief['mergedFacts']

function family(name: string, memberCount: number, axes: string[]): FamilyBrief {
  return { name, memberCount, differentiationAxes: axes, mergedFacts: FACTS }
}

describe('the marketplace blocklist', () => {
  it('recognises a marketplace, its national domains and its subdomains', () => {
    expect(isBlocklistedDomain('amazon.de')).toBe(true)
    expect(isBlocklistedDomain('www.etsy.com')).toBe(true)
    expect(isBlocklistedDomain('smile.amazon.com')).toBe(true)
    expect(isBlocklistedDomain('de.wikipedia.org')).toBe(true)
  })

  it('leaves an ordinary shop alone, including one whose name contains a listed word', () => {
    expect(isBlocklistedDomain('rival-shoes.co.uk')).toBe(false)
    // The suffix match is on a domain boundary, so this is not "…amazon.com".
    expect(isBlocklistedDomain('notamazon.com')).toBe(false)
  })
})

describe('ranking the domains seen against a store', () => {
  const ranked = [
    { keyword: 'trail running shoes', domain: 'rival.com', position: 2 },
    { keyword: 'wide fit trail shoes', domain: 'rival.com', position: 5 },
    { keyword: 'best trail shoes', domain: 'rival.com', position: 9 },
    { keyword: 'trail running shoes', domain: 'amazon.de', position: 1 },
    { keyword: 'wide fit trail shoes', domain: 'amazon.de', position: 1 },
    { keyword: 'best trail shoes', domain: 'amazon.de', position: 1 },
    { keyword: 'trail running shoes', domain: 'ourstore.com', position: 4 },
    { keyword: 'wide fit trail shoes', domain: 'shop.ourstore.com', position: 6 },
    { keyword: 'best trail shoes', domain: 'ourstore.com', position: 7 },
    { keyword: 'trail running shoes', domain: 'oneoff.com', position: 3 },
  ]

  const base = {
    ranked,
    ownDomain: 'ourstore.com',
    positionMax: 10,
    appearsInKeywordsMin: 3,
    limit: 5,
  }

  it('keeps a domain that recurs and drops the marketplace, the store itself and the one-off', () => {
    const candidates = rankCompetitorCandidates(base)
    expect(candidates.map((c) => c.domain)).toEqual(['rival.com'])
    expect(candidates[0]?.appearsInKeywords).toBe(3)
    expect(candidates[0]?.bestPosition).toBe(2)
  })

  it('never proposes the store itself, on any subdomain', () => {
    const domains = rankCompetitorCandidates({ ...base, appearsInKeywordsMin: 1 }).map(
      (c) => c.domain,
    )
    expect(domains).not.toContain('ourstore.com')
    expect(domains).not.toContain('shop.ourstore.com')
  })

  it('ignores a domain ranking below the position we count as ranking', () => {
    const deep = ranked.map((row) => ({ ...row, position: 11 }))
    expect(rankCompetitorCandidates({ ...base, ranked: deep })).toEqual([])
  })

  it('does not propose a domain the merchant already has', () => {
    const candidates = rankCompetitorCandidates({ ...base, existingDomains: ['rival.com'] })
    expect(candidates).toEqual([])
  })

  it('returns at most the limit it was given', () => {
    const many = ['a.com', 'b.com', 'c.com', 'd.com', 'e.com', 'f.com'].flatMap((domain, i) =>
      ['k1', 'k2', 'k3'].map((keyword) => ({ keyword, domain, position: i + 1 })),
    )
    expect(rankCompetitorCandidates({ ...base, ranked: many, limit: 5 })).toHaveLength(5)
  })

  it('orders by how many searches, then by how high, then by name', () => {
    const rows = [
      ...['k1', 'k2', 'k3', 'k4'].map((k) => ({ keyword: k, domain: 'often.com', position: 8 })),
      ...['k1', 'k2', 'k3'].map((k) => ({ keyword: k, domain: 'zeta.com', position: 2 })),
      ...['k1', 'k2', 'k3'].map((k) => ({ keyword: k, domain: 'alpha.com', position: 2 })),
    ]
    expect(rankCompetitorCandidates({ ...base, ranked: rows }).map((c) => c.domain)).toEqual([
      'often.com',
      'alpha.com',
      'zeta.com',
    ])
  })
})

describe('validating a competitor a merchant typed', () => {
  const own = 'ourstore.com'

  it('normalises whatever they typed to the same value a claim would produce', () => {
    const result = validateCompetitorDomain({ domain: 'HTTPS://WWW.Rival.co.uk/shop', ownDomain: own })
    expect(result).toEqual({ ok: true, domain: 'rival.co.uk' })
  })

  it('refuses their own store', () => {
    const result = validateCompetitorDomain({ domain: 'www.ourstore.com', ownDomain: own })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.rejected.reason).toBe('own_domain')
  })

  it('refuses a marketplace, and accepts the same one when the merchant insists', () => {
    const refused = validateCompetitorDomain({ domain: 'amazon.de', ownDomain: own })
    expect(refused.ok === false && refused.rejected.reason).toBe('blocklisted')

    const allowed = validateCompetitorDomain({
      domain: 'amazon.de',
      ownDomain: own,
      overrideBlocklist: true,
    })
    expect(allowed).toEqual({ ok: true, domain: 'amazon.de' })
  })

  it('will not let "add anyway" wave through their own store or a typo', () => {
    expect(
      validateCompetitorDomain({ domain: own, ownDomain: own, overrideBlocklist: true }).ok,
    ).toBe(false)
    expect(
      validateCompetitorDomain({ domain: 'not a domain', ownDomain: own, overrideBlocklist: true })
        .ok,
    ).toBe(false)
  })

  it('refuses a domain that does not resolve, and proceeds when nobody looked', () => {
    expect(
      validateCompetitorDomain({ domain: 'rival.co.uk', ownDomain: own, resolves: false }).ok,
    ).toBe(false)
    expect(validateCompetitorDomain({ domain: 'rival.co.uk', ownDomain: own }).ok).toBe(true)
  })
})

describe('validating a search term', () => {
  it('lower-cases and collapses whitespace, so one question is asked once', () => {
    expect(validateKeywordTerm('  Trail   Running  Shoes ')).toEqual({
      ok: true,
      term: 'trail running shoes',
    })
  })

  it('refuses an empty term and a sentence', () => {
    expect(validateKeywordTerm('   ').ok).toBe(false)
    expect(validateKeywordTerm('x'.repeat(200)).ok).toBe(false)
  })
})

describe('the seed brief', () => {
  it('names the language and country and describes families, never products', () => {
    const brief = renderSeedBrief({
      language: 'da',
      country: 'DK',
      description: 'En dansk butik.',
      productCategories: ['løbesko'],
      audience: 'Trail runners',
      families: [family('Trail shoes', 12, ['terrain', 'width'])],
    })
    expect(brief).toContain('Shop language: da')
    expect(brief).toContain('Shop country: DK')
    expect(brief).toContain('buyers choose between: terrain, width')
    expect(brief).toContain('used for: trail running')
  })
})

describe('deriving seed keywords', () => {
  const brief = {
    language: 'en',
    country: 'GB',
    description: 'A shop.',
    productCategories: ['shoes'],
    audience: 'runners',
    families: [family('Trail shoes', 4, ['terrain'])],
  }

  it('normalises, de-duplicates and cuts at the ceiling', async () => {
    const llm = new StubLlmClient({
      keywords: ['Trail Shoes', 'trail  shoes', '  ', 'wide trail shoes', 'best trail shoes'],
    })

    const result = await deriveSeedKeywords(
      { llm, prompt: { version: 'seeds.v1', text: 'propose terms' } },
      { accountId: 'acct', domain: 'ourstore.com', brief, candidatesMax: 2 },
    )

    expect(result.terms).toEqual(['trail shoes', 'wide trail shoes'])
    expect(result.promptVersion).toBe('seeds.v1')
  })

  it('runs on the stronger tier and is stamped with the prompt that produced it', async () => {
    const llm = new StubLlmClient({ keywords: ['trail shoes'] })
    await deriveSeedKeywords(
      { llm, prompt: { version: 'seeds.v1', text: 'propose terms' } },
      { accountId: 'acct', domain: 'ourstore.com', brief, candidatesMax: 5 },
    )
    expect(llm.requests[0]?.callType).toBe('seeds')
    expect(llm.requests[0]?.schema).toBe(SEED_KEYWORDS_SCHEMA)
  })
})

describe('picking the draft keyword set', () => {
  function metric(keyword: string, volume: number | null, competition?: number): KeywordMetric {
    return {
      keyword,
      monthlySearchVolume: volume,
      competition: competition ?? null,
      cpcUsd: null,
      monthlyHistory: [],
    }
  }

  it('keeps the highest volumes and cuts at the ceiling', () => {
    const picked = pickDraftKeywords(
      [metric('low', 10), metric('high', 900), metric('middle', 400)],
      2,
    )
    expect(picked.map((k) => k.term)).toEqual(['high', 'middle'])
  })

  it('sorts an unpriced term last rather than throwing it away', () => {
    const picked = pickDraftKeywords([metric('unpriced', null), metric('priced', 5)], 5)
    expect(picked.map((k) => k.term)).toEqual(['priced', 'unpriced'])
  })

  it('converts the vendor 0–1 competition into the 0–100 the column holds', () => {
    expect(pickDraftKeywords([metric('a', 10, 0.42)], 5)[0]?.difficulty).toBe(42)
    expect(pickDraftKeywords([metric('b', 10)], 5)[0]?.difficulty).toBeNull()
  })

  it('does not ask the same question twice under two spellings', () => {
    expect(pickDraftKeywords([metric('Trail Shoes', 100), metric('trail shoes', 90)], 5)).toHaveLength(
      1,
    )
  })
})
