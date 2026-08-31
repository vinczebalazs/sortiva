/**
 * main §12.1 — "Locale-aware: pass the persona's `main_language` + `country` as
 * the DataForSEO location/language parameters."
 *
 * DataForSEO's country location codes are Google Ads geo-target IDs, which for
 * countries are `2000 + the ISO-3166-1 numeric code` (United States: 840 → 2840;
 * Germany: 276 → 2276). So only the alpha-2 → numeric table is needed here, and
 * extending it is mechanical.
 *
 * An unmapped country throws rather than defaulting. A silently wrong location
 * returns plausible search volumes for the wrong market, and nothing downstream
 * could tell.
 */

const ISO_NUMERIC: Record<string, number> = {
  // EU / EEA / Switzerland — the markets the per-locale demand floors cover.
  AT: 40, BE: 56, BG: 100, CH: 756, CY: 196, CZ: 203, DE: 276, DK: 208,
  EE: 233, ES: 724, FI: 246, FR: 250, GR: 300, HR: 191, HU: 348, IE: 372,
  IS: 352, IT: 380, LI: 438, LT: 440, LU: 442, LV: 428, MT: 470, NL: 528,
  NO: 578, PL: 616, PT: 620, RO: 642, SE: 752, SI: 705, SK: 703,
  // Major English-language markets.
  AU: 36, CA: 124, GB: 826, NZ: 554, US: 840, ZA: 710,
  // Other frequent Shopify markets.
  AE: 784, BR: 76, IL: 376, IN: 356, JP: 392, MX: 484, SG: 702, TR: 792,
}

export function locationCodeFor(countryCode: string): number {
  const key = countryCode.trim().toUpperCase()
  const numeric = ISO_NUMERIC[key]
  if (numeric === undefined) {
    throw new Error(
      `No DataForSEO location code for country "${countryCode}". Add its ISO-3166-1 numeric code to ISO_NUMERIC (location code = 2000 + numeric).`,
    )
  }
  return 2000 + numeric
}

/** DataForSEO expects a bare two-letter language subtag: `da`, not `da-DK`. */
export function languageCodeFor(language: string): string {
  return language.trim().toLowerCase().split(/[-_]/)[0] ?? language
}
