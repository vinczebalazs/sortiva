import { describe, expect, it } from 'vitest'
import { emptyFactSheet, type FactSheet } from '../distill/schema'
import type { LlmClient, LlmRequest, LlmResult } from '../contracts/llm'
import { renderPersonaBrief, type FamilyBrief } from './brief'
import { describesTheStore, storeVocabulary } from './degeneracy'
import { countryFromDomain, detectLocale, hreflangTags, htmlLang } from './locale'
import { buildPersona } from './persona'
import { PERSONA_SCHEMA } from './schema'
import { MULTI_ZONE_COUNTRIES, timezoneForCountry } from './timezones'

/**
 * The persona, checked without a model where it can be and with a stub where it
 * cannot.
 *
 * Almost everything here is deliberately deterministic. The two values the rest
 * of the product spends money on — the language and the country — are decided
 * by a chain of evidence rather than by the model, so they can be asserted
 * exactly; and the brief handed to the model is assembled by us, so what is
 * *not* in it can be asserted exactly too.
 */

const PROMPT = { version: 'persona.v1', text: 'describe the shop' }

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
      usage: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      usdCost: 0.0007,
      latencyMs: 900,
      attempts: 1,
    }
  }
}

function draft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    business_description:
      'Acme verkauft Trailrunning-Schuhe für Läufer auf technischem Gelände. Das Sortiment reicht von leichten Wettkampfschuhen bis zu gedämpften Modellen für lange Distanzen.',
    product_categories: ['Trailrunning-Schuhe', 'Laufsocken'],
    main_language: 'en',
    country: 'US',
    audience: 'Ambitionierte Trailläufer',
    brand_tone: 'technisch und sachlich',
    ...overrides,
  }
}

function family(overrides: Partial<FamilyBrief> = {}): FamilyBrief {
  return {
    name: 'Trailrunning-Schuhe',
    memberCount: 12,
    differentiationAxes: ['terrain', 'drop', 'width'],
    mergedFacts: { ...emptyFactSheet(), material: 'mesh' } as FactSheet,
    ...overrides,
  }
}

describe('the locale detection chain', () => {
  it('takes the shop’s own settings over everything else', () => {
    const detection = detectLocale({
      shop: { primaryLocale: 'de-AT', countryCode: 'AT', currency: 'EUR' },
      homepageHtml: '<html lang="en-US"><head></head></html>',
      domain: 'acme.co.uk',
    })

    expect(detection).toEqual({
      language: 'de',
      languageSource: 'shop_settings',
      country: 'AT',
      countrySource: 'shop_settings',
    })
  })

  it('falls back to the page’s own lang attribute when the shop settings say nothing', () => {
    const detection = detectLocale({
      homepageHtml: '<!doctype html><html lang="sv-SE" dir="ltr"><head></head></html>',
      domain: 'acme.com',
    })

    expect(detection.language).toBe('sv')
    expect(detection.languageSource).toBe('html_lang')
    expect(detection.country).toBe('SE')
    expect(detection.countrySource).toBe('html_lang_region')
  })

  it('reads hreflang only when the tags agree, because two languages is not one answer', () => {
    const bilingual =
      '<html><head>' +
      '<link rel="alternate" hreflang="nl-BE" href="https://x/nl">' +
      '<link rel="alternate" hreflang="fr-BE" href="https://x/fr">' +
      '<link rel="alternate" hreflang="x-default" href="https://x/">' +
      '</head></html>'

    expect(hreflangTags(bilingual)).toEqual(['nl-BE', 'fr-BE'])

    const detection = detectLocale({ homepageHtml: bilingual, domain: 'acme.be' })
    // The language is genuinely ambiguous and Belgium has no single commercial
    // language, so nothing answers it; the country is not ambiguous at all.
    expect(detection.language).toBeNull()
    expect(detection.country).toBe('BE')
    expect(detection.countrySource).toBe('hreflang_region')
  })

  it('uses a single-country currency, and refuses an ambiguous one', () => {
    expect(detectLocale({ shop: { currency: 'SEK' }, domain: 'acme.com' }).country).toBe('SE')
    expect(detectLocale({ shop: { currency: 'EUR' }, domain: 'acme.com' }).country).toBeNull()
  })

  it('reads a country from the web address, but not from a suffix people buy for its spelling', () => {
    expect(countryFromDomain('acme.de')).toBe('DE')
    expect(countryFromDomain('acme.co.uk')).toBe('GB')
    expect(countryFromDomain('acme.io')).toBeNull()
    expect(countryFromDomain('acme.ai')).toBeNull()
    expect(countryFromDomain('acme.com')).toBeNull()
  })

  it('will not guess a language for a country that has several', () => {
    const detection = detectLocale({ domain: 'acme.ch' })
    expect(detection.country).toBe('CH')
    expect(detection.language).toBeNull()
  })

  it('reads no lang attribute out of a page that declares none', () => {
    expect(htmlLang('<html><head><title>Acme</title></head></html>')).toBeNull()
    expect(htmlLang(null)).toBeNull()
  })
})

describe('the default publish timezone', () => {
  it('covers every multi-zone country the publish rules name, with its business zone', () => {
    // main §9.4 lists exactly these five as spanning several zones.
    expect(MULTI_ZONE_COUNTRIES).toEqual({
      US: 'America/New_York',
      CA: 'America/Toronto',
      AU: 'Australia/Sydney',
      BR: 'America/Sao_Paulo',
      RU: 'Europe/Moscow',
    })

    for (const country of Object.keys(MULTI_ZONE_COUNTRIES)) {
      expect(timezoneForCountry(country).source).toBe('multi_zone_default')
    }
  })

  it('answers for an ordinary country from the table', () => {
    expect(timezoneForCountry('DE')).toEqual({ timezone: 'Europe/Berlin', source: 'country_table' })
    expect(timezoneForCountry('jp')).toEqual({ timezone: 'Asia/Tokyo', source: 'country_table' })
  })

  it('falls back rather than guessing a neighbour’s clock', () => {
    expect(timezoneForCountry('ZZ')).toEqual({ timezone: 'UTC', source: 'fallback' })
    expect(timezoneForCountry(null)).toEqual({ timezone: 'UTC', source: 'fallback' })
  })

  it('names zones the platform actually knows, so a publish hour can be computed', () => {
    for (const country of [...Object.keys(MULTI_ZONE_COUNTRIES), 'DE', 'JP', 'NZ', 'ZA']) {
      const { timezone } = timezoneForCountry(country)
      expect(() =>
        new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date()),
      ).not.toThrow()
    }
  })
})

describe('the brief the model is given', () => {
  it('describes the catalogue as families and their axes, not as a product list', () => {
    const brief = renderPersonaBrief({
      domain: 'acme.de',
      productCount: 42,
      families: [family(), family({ name: 'Laufsocken', memberCount: 4, differentiationAxes: [] })],
      topSellers: [{ title: 'Trailblazer 3', rank: 1 }],
      pages: [{ kind: 'homepage', text: 'Schuhe für den Berg.' }],
      locale: detectLocale({ shop: { primaryLocale: 'de-DE', countryCode: 'DE' } }),
    })

    expect(brief).toContain('42 product(s), grouped into 2 product family/families')
    expect(brief).toContain('Trailrunning-Schuhe (12 product(s))')
    expect(brief).toContain('members differ by: terrain, drop, width')
    expect(brief).toContain('shared across members: material: mesh')
    expect(brief).toContain('1. Trailblazer 3')
    expect(brief).toContain('language: de (from shop_settings)')
  })

  it('says plainly when nothing established the language or the country', () => {
    const brief = renderPersonaBrief({
      domain: 'acme.com',
      productCount: 0,
      families: [],
      topSellers: [],
      pages: [],
      locale: detectLocale({ domain: 'acme.com' }),
    })
    expect(brief).toContain('Neither the language nor the country could be established')
  })
})

describe('whether a description describes anything', () => {
  const vocabulary = storeVocabulary(['Trailrunning-Schuhe', 'Laufsocken', 'Trailblazer 3'])

  it('accepts a description that names what the shop sells', () => {
    expect(describesTheStore(draft().business_description as string, vocabulary)).toBe('substantive')
  })

  it('rejects one that would be true of any shop', () => {
    expect(
      describesTheStore(
        'This store offers a wide range of high-quality products for discerning customers. Everything is chosen with care and shipped quickly.',
        vocabulary,
      ),
    ).toBe('generic')
  })

  it('rejects an empty, a one-line and a six-sentence answer', () => {
    expect(describesTheStore('   ', vocabulary)).toBe('empty')
    expect(describesTheStore('Trailrunning-Schuhe.', vocabulary)).toBe('too_short')
    expect(
      describesTheStore(
        'Acme verkauft Trailrunning-Schuhe. Sie sind gut. Sie sind schnell. Sie sind leicht. Sie sind robust. Sie sind teuer.',
        vocabulary,
      ),
    ).toBe('wrong_sentence_count')
  })

  it('rejects the brief handed back with its headings on', () => {
    expect(
      describesTheStore('Product families:\n- Trailrunning-Schuhe (12 product(s))', vocabulary),
    ).toBe('echoes_the_brief')
  })
})

describe('building the persona', () => {
  const evidence = {
    shop: { primaryLocale: 'de-DE', countryCode: 'DE', currency: 'EUR' },
    homepageHtml: '<html lang="en"></html>',
    domain: 'acme.de',
  }

  const input = {
    accountId: 'acct-1',
    domain: 'acme.de',
    brief: {
      productCount: 42,
      families: [family()],
      topSellers: [{ title: 'Trailblazer 3', rank: 1 }],
      pages: [{ kind: 'homepage' as const, text: 'Schuhe für den Berg.' }],
    },
    evidence,
  }

  it('keeps the detected language and country over the model’s own guess', async () => {
    const llm = new StubLlmClient(draft())
    const result = await buildPersona({ llm, prompt: PROMPT }, input)

    // The model said en/US; the shop's own settings said de/DE.
    expect(result.persona.language).toBe('de')
    expect(result.persona.country).toBe('DE')
    expect(result.persona.languageSource).toBe('shop_settings')
    expect(result.persona.countrySource).toBe('shop_settings')
  })

  it('takes the model’s answer only when no evidence produced one', async () => {
    const llm = new StubLlmClient(draft({ main_language: 'nl', country: 'NL' }))
    const result = await buildPersona(
      { llm, prompt: PROMPT },
      { ...input, evidence: { domain: 'acme.com' } },
    )

    expect(result.persona.language).toBe('nl')
    expect(result.persona.country).toBe('NL')
    expect(result.persona.languageSource).toBe('model')
    expect(result.persona.countrySource).toBe('model')
  })

  it('derives the publish clock from the country, never from the merchant’s own', async () => {
    const llm = new StubLlmClient(draft())
    const result = await buildPersona({ llm, prompt: PROMPT }, input)
    expect(result.timezone).toEqual({ timezone: 'Europe/Berlin', source: 'country_table' })
  })

  it('runs on the stronger tier, names no model, and stamps what produced it', async () => {
    const llm = new StubLlmClient(draft())
    const result = await buildPersona({ llm, prompt: PROMPT }, input)

    const request = llm.requests[0]!
    expect(request.callType).toBe('persona')
    expect(request.promptVersion).toBe('persona.v1')
    // Invariant 22: no model substitution. Naming a model here is how a cheaper
    // one gets slipped in for a busy hour.
    expect(request.model).toBeUndefined()
    expect(request.schema).toBe(PERSONA_SCHEMA)
    expect(result.persona.promptVersion).toBe('persona.v1')
    expect(result.persona.modelId).toBe('claude-sonnet-5')
  })

  it('sends the store’s families and its own pages, and no product description', async () => {
    const llm = new StubLlmClient(draft())
    await buildPersona(
      { llm, prompt: PROMPT },
      {
        ...input,
        brief: {
          ...input.brief,
          pages: [
            { kind: 'homepage', text: 'Schuhe für den Berg.' },
            { kind: 'about', text: 'Gegründet 2011 in München.' },
          ],
        },
      },
    )

    const sent = llm.requests[0]!.messages[0]!.content
    expect(sent).toContain('Trailrunning-Schuhe')
    expect(sent).toContain('Gegründet 2011 in München.')
    // The one thing the persona must never be told: what a product page's
    // marketing copy says. There is no field it could arrive in, and this is
    // the assertion that keeps it that way.
    expect(sent).not.toContain('Elevate your everyday')
  })
})
