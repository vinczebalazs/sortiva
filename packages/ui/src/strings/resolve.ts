import { DEFAULT_LANGUAGE, isSupportedLanguage, type UiLanguage } from './catalog'

/**
 * Which language the interface is in. The store's own content language is a
 * separate thing entirely — articles follow the merchant's persona, and this
 * setting never touches them.
 *
 * The saved preference wins if there is one; otherwise the browser's own
 * language ordering decides; otherwise English. A language we do not ship falls
 * back rather than throwing, because a merchant with an unsupported browser
 * locale must still get a working interface.
 */
export interface LanguagePreference {
  /** `account_settings.ui_language`, null until the merchant overrides it. */
  readonly saved?: string | null
  /** `navigator.languages`, or the `Accept-Language` header split into tags. */
  readonly browser?: readonly string[]
}

export function resolveLanguage(preference: LanguagePreference = {}): UiLanguage {
  if (isSupportedLanguage(preference.saved)) return preference.saved

  for (const tag of preference.browser ?? []) {
    // `en-GB` and `en` are the same catalogue to us; region only matters once a
    // language ships more than one variant, which none does.
    const base = tag.split('-')[0]?.toLowerCase()
    if (isSupportedLanguage(base)) return base
  }

  return DEFAULT_LANGUAGE
}

/** Reads the browser's language ordering where there is a browser to read. */
export function browserLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return []
  return navigator.languages ?? (navigator.language ? [navigator.language] : [])
}
