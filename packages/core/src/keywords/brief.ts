import type { FamilyBrief } from '../persona/brief'
import { SEED_BRIEF_MAX_FAMILIES } from './schema'

/**
 * What the seed call is told about a store.
 *
 * Families and their differentiation axes, not products — which is the whole
 * reason grouping exists. A term like "wide fit trail running shoes" is only
 * available to a model that has been told width and terrain are what this
 * shop's buyers choose between; a list of four hundred product titles hides
 * exactly that.
 *
 * The quarantine on product marketing holds by shape, as it does for the
 * persona: a family carries the facts its members agree on and the axes they
 * differ along, and there is no field a product description could travel in.
 * The one piece of prose here is the store's own business description, which is
 * our own sentence about them rather than their copy about themselves.
 */

export interface SeedBriefInput {
  /** The store's own language, as an ISO-639-1 code. The terms must be written in it. */
  readonly language: string
  /** ISO-3166 alpha-2. Which country's searches these are meant to be. */
  readonly country: string
  /** Our description of the business, from the confirmed or draft profile. */
  readonly description: string
  /** The broad categories the store sells in, in the store's own language. */
  readonly productCategories: readonly string[]
  readonly audience: string
  readonly families: readonly FamilyBrief[]
}

export function renderSeedBrief(input: SeedBriefInput): string {
  const sections: string[] = []

  sections.push(
    `Shop language: ${input.language}\nShop country: ${input.country}\n` +
      `Write every search term in that language, as somebody in that country would type it.`,
  )

  sections.push(`What the shop is:\n${input.description.trim()}`)

  if (input.productCategories.length > 0) {
    sections.push(`Categories it sells in: ${input.productCategories.join(', ')}`)
  }

  const audience = input.audience.trim()
  if (audience !== '') sections.push(`Who buys from it: ${audience}`)

  const families = [...input.families]
    .sort((a, b) => b.memberCount - a.memberCount || a.name.localeCompare(b.name))
    .slice(0, SEED_BRIEF_MAX_FAMILIES)

  if (families.length > 0) {
    sections.push(
      [
        `Product families (${input.families.length} in total` +
          `${families.length < input.families.length ? `, the ${families.length} largest listed` : ''}):`,
        ...families.map(renderFamily),
      ].join('\n'),
    )
  }

  return sections.join('\n\n')
}

function renderFamily(family: FamilyBrief): string {
  const lines = [`- ${family.name} (${family.memberCount} product(s))`]
  if (family.differentiationAxes.length > 0) {
    lines.push(`  buyers choose between: ${family.differentiationAxes.join(', ')}`)
  }
  const uses = family.mergedFacts.use_cases_stated
    .map((use) => use.trim())
    .filter((use) => use !== '')
  if (uses.length > 0) lines.push(`  used for: ${uses.join(', ')}`)
  const material = family.mergedFacts.material?.trim()
  if (material) lines.push(`  made of: ${material}`)
  return lines.join('\n')
}
