import type { StringKey } from './catalog'
import { t as defaultTranslate, type Translate } from './translate'

/**
 * The engine's own names for things, turned into words a merchant reads.
 *
 * These live beside the catalogue rather than beside the first screen that
 * needed them, because more than one surface names the same thing: the quality
 * report on an article page lists every criterion the judge scored, the
 * override dialog restates the ones it objected to, and the sentence explaining
 * a held calendar day names the ones that failed. Three lookups would
 * eventually disagree — and for a while there was only one, which is why the
 * calendar shipped showing a merchant `informationGain`.
 */

/**
 * A criterion's name, in words. Anything the catalogue has no entry for is
 * spelled out from its own name rather than shown as a code — the judge's
 * criteria are the engine's to name, and a new one arriving before its wording
 * does is a real possibility.
 */
export function criterionLabel(criterion: string, t: Translate = defaultTranslate): string {
  try {
    return t(`content.article.quality.criterion.${criterion}` as StringKey)
  } catch {
    return criterion
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/[_-]+/g, ' ')
      .replace(/^./, (char) => char.toUpperCase())
  }
}

/**
 * The criteria a gate says a draft fell short on, as a merchant reads them.
 *
 * The gate hands the renderer one string with the names already joined —
 * `informationGain, factualGrounding` — rather than a list, so this splits it
 * back apart to name each one. **The split is a workaround for the shape the
 * value arrives in, not a design**: nothing here depends on the joining, so a
 * single name reads correctly today and a list would need only the split
 * removed once the gate sends one.
 *
 * A name the catalogue has no wording for is spelled out rather than dropped.
 * Telling a merchant their draft was held back on nothing at all is worse than
 * an ungainly name.
 */
export function criteriaNamed(value: string | number, t: Translate = defaultTranslate): string {
  return String(value)
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
    .map((name) => criterionLabel(name, t))
    .join(', ')
}
