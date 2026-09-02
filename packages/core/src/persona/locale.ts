/**
 * What language this store is written in, and which country it sells into.
 *
 * Two values with more riding on them than their size suggests. They are the
 * parameters every later search-data lookup is made with, so a wrong country
 * does not fail loudly — it quietly buys another market's search volumes and
 * every number after that is about the wrong country. They also decide which
 * language we write in and, through the country, what time of day we publish.
 *
 * So they are worked out from evidence, in a fixed order, strongest first, and
 * each answer records which link in the chain produced it. Nothing here guesses
 * when the evidence is ambiguous: two languages claimed side by side means "we
 * do not know", and the next link is asked instead.
 *
 * Note what is *not* an input: product descriptions. The store's own
 * configuration, its homepage markup and its address are the whole evidence
 * base, and the merchant's marketing copy is quarantined well upstream of here.
 */

/** Which link in the chain produced the language. */
export type LanguageSource = 'shop_settings' | 'html_lang' | 'hreflang' | 'tld' | 'model'
/** Which link in the chain produced the country. */
export type CountrySource =
  | 'shop_settings'
  | 'shop_locale_region'
  | 'html_lang_region'
  | 'hreflang_region'
  | 'currency'
  | 'tld'
  | 'model'

/** What the store's own settings say, read through the Shopify grant. The strongest evidence there is. */
export interface ShopLocaleSettings {
  /** Shopify's `primary_locale`, e.g. `de` or `de-DE`. */
  readonly primaryLocale?: string | null
  /** ISO-3166 alpha-2, e.g. `DE`. */
  readonly countryCode?: string | null
  /** ISO-4217, e.g. `EUR`. */
  readonly currency?: string | null
}

export interface LocaleEvidence {
  readonly shop?: ShopLocaleSettings | undefined
  /** The storefront homepage as fetched, markup and all. Read for its tags, never for its prose. */
  readonly homepageHtml?: string | null | undefined
  /** The claimed domain, normalised to eTLD+1. Its suffix is the weakest signal here. */
  readonly domain?: string | null | undefined
}

export interface LocaleDetection {
  /** ISO-639-1, lower case. Null when no link in the chain produced one. */
  readonly language: string | null
  readonly languageSource: LanguageSource | null
  /** ISO-3166 alpha-2, upper case. Null when no link in the chain produced one. */
  readonly country: string | null
  readonly countrySource: CountrySource | null
}

/**
 * Currencies used by exactly one country, so seeing one names it.
 *
 * The euro, the dollar and the pound are deliberately absent: a store priced in
 * euros could be in any of twenty countries, and answering "DE" because euros
 * are most often German is the kind of confident wrong answer this chain exists
 * to avoid. An ambiguous currency simply does not answer, and the chain moves on.
 */
const SINGLE_COUNTRY_CURRENCIES: Readonly<Record<string, string>> = {
  BRL: 'BR', CHF: 'CH', CNY: 'CN', CZK: 'CZ', DKK: 'DK', EGP: 'EG', HUF: 'HU',
  IDR: 'ID', ILS: 'IL', INR: 'IN', ISK: 'IS', JPY: 'JP', KRW: 'KR', MAD: 'MA',
  MXN: 'MX', MYR: 'MY', NGN: 'NG', PEN: 'PE', PHP: 'PH', PLN: 'PL', RON: 'RO',
  RSD: 'RS', RUB: 'RU', SAR: 'SA', SEK: 'SE', SGD: 'SG', THB: 'TH', TRY: 'TR',
  TWD: 'TW', UAH: 'UA', VND: 'VN', ZAR: 'ZA',
}

/**
 * Two-letter suffixes that are country codes on paper and brand names in
 * practice. A shop at `example.io` is not selling into the Indian Ocean
 * Territory, and one at `example.ai` is far likelier to be selling software
 * than to be in Anguilla.
 */
const NON_GEOGRAPHIC_CCTLDS = new Set([
  'ai', 'am', 'cc', 'co', 'fm', 'gg', 'io', 'la', 'li', 'me', 'ly', 'sh', 'st',
  'to', 'tv', 'ws',
])

/**
 * The language a country's commerce is conducted in, where there is only one
 * sensible answer.
 *
 * Only consulted as the last deterministic resort, when a store's address is
 * the only evidence left. Multilingual countries — Switzerland, Belgium,
 * Canada — are absent on purpose: picking one of their languages from the
 * address alone would be a coin toss written as a fact.
 */
const COUNTRY_PRIMARY_LANGUAGE: Readonly<Record<string, string>> = {
  AR: 'es', AT: 'de', BG: 'bg', BR: 'pt', CL: 'es', CN: 'zh', CO: 'es',
  CZ: 'cs', DE: 'de', DK: 'da', EE: 'et', ES: 'es', FI: 'fi', FR: 'fr',
  GB: 'en', GR: 'el', HR: 'hr', HU: 'hu', ID: 'id', IE: 'en', IL: 'he',
  IS: 'is', IT: 'it', JP: 'ja', KR: 'ko', LT: 'lt', LV: 'lv', MX: 'es',
  NL: 'nl', NO: 'no', NZ: 'en', PE: 'es', PL: 'pl', PT: 'pt', RO: 'ro',
  RS: 'sr', RU: 'ru', SE: 'sv', SI: 'sl', SK: 'sk', TH: 'th', TR: 'tr',
  UA: 'uk', US: 'en', VN: 'vi',
}

const LANGUAGE_TAG = /^([a-z]{2,3})(?:[-_]([a-z]{4}))?(?:[-_]([a-z]{2}|\d{3}))?/i

interface ParsedTag {
  readonly language: string | null
  readonly region: string | null
}

/** `de-DE` → `{ de, DE }`; `de` → `{ de, null }`; anything unrecognisable → both null. */
export function parseLanguageTag(tag: string | null | undefined): ParsedTag {
  const match = LANGUAGE_TAG.exec((tag ?? '').trim())
  if (!match?.[1]) return { language: null, region: null }
  const region = match[3]
  return {
    language: match[1].toLowerCase(),
    // A three-digit UN region code ("419" for Latin America) is a real language
    // tag and not a country, so it is dropped rather than stored as one.
    region: region && /^[a-z]{2}$/i.test(region) ? region.toUpperCase() : null,
  }
}

/** The `lang` attribute on the document element, if the page declares one. */
export function htmlLang(html: string | null | undefined): string | null {
  if (!html) return null
  const openingTag = /<html\b[^>]*>/i.exec(html)
  if (!openingTag?.[0]) return null
  const lang = /\blang\s*=\s*["']?([a-zA-Z0-9_-]+)/.exec(openingTag[0])
  return lang?.[1] ?? null
}

/**
 * Every `hreflang` the page declares, `x-default` excluded — it names a
 * fallback page rather than a language.
 */
export function hreflangTags(html: string | null | undefined): string[] {
  if (!html) return []
  const tags: string[] = []
  for (const link of html.match(/<link\b[^>]*>/gi) ?? []) {
    if (!/\brel\s*=\s*["']?alternate/i.test(link)) continue
    const value = /\bhreflang\s*=\s*["']?([a-zA-Z0-9_-]+)/.exec(link)?.[1]
    if (!value || value.toLowerCase() === 'x-default') continue
    tags.push(value)
  }
  return tags
}

/**
 * The one language a set of `hreflang` tags agrees on, or null.
 *
 * A store publishing in German and French has told us it does not have a single
 * language, and answering with whichever tag came first would be reading the
 * order of the markup as a statement about the business.
 */
function unanimous(values: readonly (string | null)[]): string | null {
  const distinct = new Set(values.filter((value): value is string => value !== null))
  return distinct.size === 1 ? [...distinct][0]! : null
}

/**
 * Countries with no single commercial language. The language chain must refuse
 * to answer for them from an address alone; the *country* chain may still name
 * them, because where a shop is and what it writes in are different questions.
 */
const MULTI_LANGUAGE_COUNTRIES = new Set(['AE', 'BE', 'CA', 'CH', 'IN', 'MY', 'SG', 'ZA'])

/** The domain's suffix as a country, when the suffix is one a shop's address really implies. */
export function countryFromDomain(domain: string | null | undefined): string | null {
  const host = (domain ?? '').trim().toLowerCase().replace(/\.$/, '')
  const suffix = host.split('.').pop()
  if (!suffix || suffix.length !== 2 || NON_GEOGRAPHIC_CCTLDS.has(suffix)) return null
  // `.uk` is the live suffix; `GB` is the code every other part of the product
  // and every search-data vendor uses.
  const code = suffix === 'uk' ? 'GB' : suffix.toUpperCase()
  // Only suffixes we can place. An unrecognised two-letter suffix is more
  // likely to be a brand's clever spelling than a statement about a market.
  const known = code in COUNTRY_PRIMARY_LANGUAGE || MULTI_LANGUAGE_COUNTRIES.has(code)
  return known ? code : null
}

/**
 * The chain, run once. Language and country are resolved independently, because
 * the evidence for them is not the same evidence: a store can declare
 * `lang="en"` and be plainly in Sweden, and forcing one answer to follow the
 * other would make the weaker of the two wrong.
 */
export function detectLocale(evidence: LocaleEvidence): LocaleDetection {
  const shopLocale = parseLanguageTag(evidence.shop?.primaryLocale)
  const pageLang = parseLanguageTag(htmlLang(evidence.homepageHtml))
  const hreflang = hreflangTags(evidence.homepageHtml).map(parseLanguageTag)
  const tldCountry = countryFromDomain(evidence.domain)

  let language: string | null = null
  let languageSource: LanguageSource | null = null
  if (shopLocale.language) {
    language = shopLocale.language
    languageSource = 'shop_settings'
  } else if (pageLang.language) {
    language = pageLang.language
    languageSource = 'html_lang'
  } else {
    const agreed = unanimous(hreflang.map((tag) => tag.language))
    if (agreed) {
      language = agreed
      languageSource = 'hreflang'
    } else if (tldCountry && COUNTRY_PRIMARY_LANGUAGE[tldCountry]) {
      language = COUNTRY_PRIMARY_LANGUAGE[tldCountry]!
      languageSource = 'tld'
    }
  }

  const shopCountry = normaliseCountry(evidence.shop?.countryCode)
  const currencyCountry = SINGLE_COUNTRY_CURRENCIES[(evidence.shop?.currency ?? '').trim().toUpperCase()]
  const hreflangRegion = unanimous(hreflang.map((tag) => tag.region))

  let country: string | null = null
  let countrySource: CountrySource | null = null
  if (shopCountry) {
    country = shopCountry
    countrySource = 'shop_settings'
  } else if (shopLocale.region) {
    country = shopLocale.region
    countrySource = 'shop_locale_region'
  } else if (pageLang.region) {
    country = pageLang.region
    countrySource = 'html_lang_region'
  } else if (hreflangRegion) {
    country = hreflangRegion
    countrySource = 'hreflang_region'
  } else if (currencyCountry) {
    country = currencyCountry
    countrySource = 'currency'
  } else if (tldCountry) {
    country = tldCountry
    countrySource = 'tld'
  }

  return { language, languageSource, country, countrySource }
}

function normaliseCountry(value: string | null | undefined): string | null {
  const code = (value ?? '').trim().toUpperCase()
  return /^[A-Z]{2}$/.test(code) ? code : null
}
