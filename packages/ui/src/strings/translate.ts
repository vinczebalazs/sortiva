import { CATALOGS, DEFAULT_LANGUAGE, type StringKey, type UiLanguage } from './catalog'

export type StringParams = Readonly<Record<string, string | number>>

/** Looks a string up and fills its `{placeholders}`. */
export type Translate = (key: StringKey, params?: StringParams) => string

const PLACEHOLDER = /\{(\w+)\}/g

/**
 * A sentence that changes shape with a number writes both shapes, and the
 * number chooses:
 *
 *     {competing_urls, plural, one {page} other {pages}}
 *
 * Written here rather than left to each caller because the alternative — a
 * second key and a branch at the call site — is right until somebody forgets,
 * and forgetting shows a merchant "1 pages" rather than failing. There is a
 * test that refuses any sentence carrying a countable number without it.
 *
 * The categories come from `Intl.PluralRules`, which is in the runtime, so a
 * catalogue in a language with three or four of them says so and this needs no
 * change. English has two; only `other` is required.
 */
const PLURAL_OPENER = /\{(\w+),\s*plural,/

interface PluralBlock {
  readonly start: number
  readonly end: number
  readonly name: string
  readonly forms: Readonly<Record<string, string>>
}

/** Reads one `{name, plural, …}` block, brace-balanced so a form may itself hold a `{placeholder}`. */
function readPluralBlock(template: string, from: number): PluralBlock | null {
  const opener = PLURAL_OPENER.exec(template.slice(from))
  if (!opener) return null
  const start = from + opener.index
  let cursor = start + opener[0].length
  const forms: Record<string, string> = {}

  while (cursor < template.length) {
    while (cursor < template.length && /\s/.test(template[cursor]!)) cursor += 1
    if (template[cursor] === '}') return { start, end: cursor + 1, name: opener[1]!, forms }

    const category = /^(\w+)\s*\{/.exec(template.slice(cursor))
    if (!category) return null
    cursor += category[0].length

    let depth = 1
    const contentStart = cursor
    while (cursor < template.length && depth > 0) {
      if (template[cursor] === '{') depth += 1
      else if (template[cursor] === '}') depth -= 1
      cursor += 1
    }
    if (depth !== 0) return null
    forms[category[1]!] = template.slice(contentStart, cursor - 1)
  }
  return null
}

/**
 * The number a plural block chooses by, or null when there is nothing to choose
 * by.
 *
 * Several screens hand the renderer a number they have already turned into text
 * — evidence chips and the performance deltas group thousands, so a merchant
 * reads "12,480" rather than "12480". Those still have to be able to say "1
 * click", and "1" is written the same way whether it arrived as a number or as
 * text. Anything that is not plainly a number keeps the general form rather
 * than guessing at it; grouped thousands are never one, so nothing is lost.
 */
function quantity(value: string | number | undefined): number | null {
  if (typeof value === 'number') return value
  if (typeof value !== 'string' || value.trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function applyPlurals(template: string, params: StringParams, rules: Intl.PluralRules): string {
  let out = template
  let from = 0
  for (;;) {
    const block = readPluralBlock(out, from)
    if (!block) return out
    const number = quantity(params[block.name])
    // A block whose number was not supplied keeps the general form rather than
    // vanishing: a missing parameter must not silently delete half a sentence.
    const category = number === null ? 'other' : rules.select(number)
    const chosen = block.forms[category] ?? block.forms.other ?? ''
    out = out.slice(0, block.start) + chosen + out.slice(block.end)
    from = block.start + chosen.length
  }
}

export function createTranslate(language: UiLanguage = DEFAULT_LANGUAGE): Translate {
  const catalog = CATALOGS[language] ?? CATALOGS[DEFAULT_LANGUAGE]
  const fallback = CATALOGS[DEFAULT_LANGUAGE]
  const rules = new Intl.PluralRules(language)

  return (key, params) => {
    // A key missing from a translated catalogue shows the English sentence, not
    // the key: a merchant seeing `nav.dashboard` on screen is worse than seeing
    // it in the wrong language.
    const template = catalog[key] ?? fallback[key]
    if (template === undefined) {
      throw new Error(`No string for key "${key}". Add it to packages/ui/strings/en.json.`)
    }
    if (params === undefined) return template
    return applyPlurals(template, params, rules).replace(PLACEHOLDER, (whole, name: string) => {
      const value = params[name]
      return value === undefined ? whole : String(value)
    })
  }
}

/** The English translator, for code with no language in hand (tests, snapshots). */
export const t: Translate = createTranslate(DEFAULT_LANGUAGE)
