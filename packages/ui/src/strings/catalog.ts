import en from '../../strings/en.json'

/**
 * Every user-facing word in the product lives in `packages/ui/strings/*.json`
 * and nowhere else, so a sentence can be found, reviewed and translated without
 * reading components. A lint rule rejects literal text in JSX to keep it that
 * way.
 *
 * Keys beginning `appendixA.` are the sentences the product is not free to
 * reword: they are quoted verbatim in the main spec's canonical-copy table, and
 * a test holds each one character for character. Everything else is ordinary
 * interface copy.
 */

export type StringKey = keyof typeof en

export type Catalog = Readonly<Record<StringKey, string>>

/**
 * V1 ships English only, but the shape is plural from the first day so adding a
 * language is a new file rather than a refactor of every call site.
 */
export const CATALOGS = { en: en as Catalog } as const

export type UiLanguage = keyof typeof CATALOGS

export const DEFAULT_LANGUAGE: UiLanguage = 'en'

export const SUPPORTED_LANGUAGES = Object.keys(CATALOGS) as readonly UiLanguage[]

export function isSupportedLanguage(value: string | null | undefined): value is UiLanguage {
  return typeof value === 'string' && value in CATALOGS
}
