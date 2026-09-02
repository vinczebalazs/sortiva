import { CATALOGS, DEFAULT_LANGUAGE, type StringKey, type UiLanguage } from './catalog'

export type StringParams = Readonly<Record<string, string | number>>

/** Looks a string up and fills its `{placeholders}`. */
export type Translate = (key: StringKey, params?: StringParams) => string

const PLACEHOLDER = /\{(\w+)\}/g

export function createTranslate(language: UiLanguage = DEFAULT_LANGUAGE): Translate {
  const catalog = CATALOGS[language] ?? CATALOGS[DEFAULT_LANGUAGE]
  const fallback = CATALOGS[DEFAULT_LANGUAGE]

  return (key, params) => {
    // A key missing from a translated catalogue shows the English sentence, not
    // the key: a merchant seeing `nav.dashboard` on screen is worse than seeing
    // it in the wrong language.
    const template = catalog[key] ?? fallback[key]
    if (template === undefined) {
      throw new Error(`No string for key "${key}". Add it to packages/ui/strings/en.json.`)
    }
    if (params === undefined) return template
    return template.replace(PLACEHOLDER, (whole, name: string) => {
      const value = params[name]
      return value === undefined ? whole : String(value)
    })
  }
}

/** The English translator, for code with no language in hand (tests, snapshots). */
export const t: Translate = createTranslate(DEFAULT_LANGUAGE)
