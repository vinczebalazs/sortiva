/**
 * Which clock a store's articles are published against.
 *
 * The rule this table serves is the audience's clock, not the merchant's and
 * not ours: a German store run from Bali publishes at nine in the morning
 * Berlin time, because that is when its readers are awake. So the zone is
 * derived from the *country the persona says the store sells into*, and
 * deliberately not from the timezone Shopify holds for the shop — that one is
 * the owner's own working clock and is the wrong answer for exactly the store
 * that most needs the right one.
 *
 * Five countries span several zones and cannot have one correct answer. For
 * those the entry is the country's most populous business zone, and the
 * merchant can pick a different one in settings; the value here only decides
 * where they start.
 */

/** Where a zone came from, so a wrong publish hour can be explained rather than guessed at. */
export type TimezoneSource = 'country_table' | 'multi_zone_default' | 'fallback'

export interface TimezoneChoice {
  /** An IANA zone name, e.g. `Europe/Berlin`. */
  readonly timezone: string
  readonly source: TimezoneSource
}

/**
 * Countries that span more than one zone, where the entry is a choice rather
 * than a fact. Kept separate from the main table so the difference is visible:
 * a merchant in Vancouver is genuinely three hours out from what we picked, and
 * that is a thing to be able to point at rather than discover.
 */
export const MULTI_ZONE_COUNTRIES: Readonly<Record<string, string>> = {
  US: 'America/New_York',
  CA: 'America/Toronto',
  AU: 'Australia/Sydney',
  BR: 'America/Sao_Paulo',
  RU: 'Europe/Moscow',
}

/**
 * Country → the zone its business day runs on.
 *
 * Not exhaustive and not meant to be: it covers the markets a Shopify store is
 * realistically selling into, and anything outside it falls back rather than
 * being guessed at. Adding a country is one line and needs no migration.
 */
const COUNTRY_TIMEZONES: Readonly<Record<string, string>> = {
  AE: 'Asia/Dubai',
  AR: 'America/Argentina/Buenos_Aires',
  AT: 'Europe/Vienna',
  BE: 'Europe/Brussels',
  BG: 'Europe/Sofia',
  CH: 'Europe/Zurich',
  CL: 'America/Santiago',
  CN: 'Asia/Shanghai',
  CO: 'America/Bogota',
  CZ: 'Europe/Prague',
  DE: 'Europe/Berlin',
  DK: 'Europe/Copenhagen',
  EE: 'Europe/Tallinn',
  EG: 'Africa/Cairo',
  ES: 'Europe/Madrid',
  FI: 'Europe/Helsinki',
  FR: 'Europe/Paris',
  GB: 'Europe/London',
  GR: 'Europe/Athens',
  HK: 'Asia/Hong_Kong',
  HR: 'Europe/Zagreb',
  HU: 'Europe/Budapest',
  ID: 'Asia/Jakarta',
  IE: 'Europe/Dublin',
  IL: 'Asia/Jerusalem',
  IN: 'Asia/Kolkata',
  IS: 'Atlantic/Reykjavik',
  IT: 'Europe/Rome',
  JP: 'Asia/Tokyo',
  KR: 'Asia/Seoul',
  LT: 'Europe/Vilnius',
  LU: 'Europe/Luxembourg',
  LV: 'Europe/Riga',
  MA: 'Africa/Casablanca',
  MX: 'America/Mexico_City',
  MY: 'Asia/Kuala_Lumpur',
  NG: 'Africa/Lagos',
  NL: 'Europe/Amsterdam',
  NO: 'Europe/Oslo',
  NZ: 'Pacific/Auckland',
  PE: 'America/Lima',
  PH: 'Asia/Manila',
  PL: 'Europe/Warsaw',
  PT: 'Europe/Lisbon',
  RO: 'Europe/Bucharest',
  RS: 'Europe/Belgrade',
  SA: 'Asia/Riyadh',
  SE: 'Europe/Stockholm',
  SG: 'Asia/Singapore',
  SI: 'Europe/Ljubljana',
  SK: 'Europe/Bratislava',
  TH: 'Asia/Bangkok',
  TR: 'Europe/Istanbul',
  TW: 'Asia/Taipei',
  UA: 'Europe/Kyiv',
  VN: 'Asia/Ho_Chi_Minh',
  ZA: 'Africa/Johannesburg',
}

/**
 * The zone a country with no entry publishes against.
 *
 * UTC rather than a guess at a neighbour's zone. A store publishing an hour or
 * two off its own morning is a mild inconvenience the merchant can correct in
 * settings; a store told confidently that it is on someone else's clock is a
 * wrong answer wearing a right one's clothes.
 */
export const FALLBACK_TIMEZONE = 'UTC'

export function timezoneForCountry(country: string | null | undefined): TimezoneChoice {
  const code = (country ?? '').trim().toUpperCase()

  const multi = MULTI_ZONE_COUNTRIES[code]
  if (multi) return { timezone: multi, source: 'multi_zone_default' }

  const single = COUNTRY_TIMEZONES[code]
  if (single) return { timezone: single, source: 'country_table' }

  return { timezone: FALLBACK_TIMEZONE, source: 'fallback' }
}

/** Every country the table answers for. Used by its own test and by nothing else. */
export function coveredCountries(): readonly string[] {
  return [...Object.keys(MULTI_ZONE_COUNTRIES), ...Object.keys(COUNTRY_TIMEZONES)].sort()
}
