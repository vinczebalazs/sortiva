import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hasCopy } from '@sortiva/ui/strings/reason-copy'

/**
 * Every explanation key written by hand anywhere in the repository, checked
 * against the sentences the product actually holds.
 *
 * The existing guard on this vocabulary asks the engine's own producers what
 * keys they emit and looks each one up. It cannot see a key that was typed
 * into a fixture, because a fixture carries the key as data and never looks it
 * up — so when two orphan keys were deleted from the catalogue for never being
 * produced, eight fixtures went on naming them and nothing failed. A fixture
 * that describes a card the product cannot make is worse than no fixture: it
 * is a worked example of a screen state that does not exist, and the next
 * person to copy it inherits the mistake.
 *
 * This is the check from the other side. It reads source text rather than
 * calling anything, because that is the only way to see a literal that is
 * never executed.
 */

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '../../../../../..')

/** Where hand-written keys live. `node_modules` and build output are nobody's writing. */
const SEARCH_ROOTS = ['packages', 'apps']
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', '.next', 'coverage', '.turbo'])

/**
 * The field names a template key is written under. All of them end up in the
 * same renderer: `reasonTemplateKey` is the stored column, `templateKey` the
 * wire shape, `whyLine` the calendar's own column, `reasonKey` the name a test
 * harness uses when it plants a row.
 */
const KEY_FIELDS = /(?:reasonTemplateKey|templateKey|whyLine|reasonKey)\s*:\s*'([^']*)'/g

/**
 * Keys deliberately absent from the catalogue, because the test naming them is
 * about what happens when a key is missing.
 *
 * The renderer answers an unknown key with an honest admission rather than a
 * crash, and that behaviour needs proving with a key that will never exist. A
 * real key would make those tests pass for the wrong reason.
 */
const DELIBERATELY_UNKNOWN: readonly string[] = [
  'nothing.here',
  'gate3.a_reason_nobody_has_written',
  // Stand-in text in fixtures that store a why-line they never render.
  'x',
  'x.y',
]

/**
 * Keys with no sentence anywhere, left as they are because every one of them
 * sits in another lane's files.
 *
 * A list that names them is the difference between a known debt and an
 * invisible one: a new orphan fails here immediately, and one of these
 * quietly acquiring a sentence fails here too, so the list cannot outlive its
 * entries. **Nothing may be added to make a change pass** — it records work
 * already found, with who owns each piece.
 */
const AWAITING_ANOTHER_LANE: readonly string[] = [
  // The repair path's own missing sentence — the subject of the R-REPAIR-COPY
  // card, which is Lane F's.
  'product_change_impact.product_deleted',
  // Fixtures naming a key nothing produces. The engine writes
  // `<signal>.<action>`; these were written as `opportunity.<signal>`, which is
  // not a shape the catalogue has ever held. Twenty-four sightings across the
  // content, publishing, drift and recommendation suites — none of them ours,
  // and none of them rendered, since they are rows a test plants and reads back.
  'opportunity.uncovered_commercial_query',
  'opportunity.existing_page_intent_gap',
  'opportunity.missing_or_weak_metadata',
  'opportunity.indexing_issue',
  'opportunity.cannibalization',
  'opportunity.content_decay',
  // A fixture naming a rewrite reason that does not exist; the two real ones
  // are `freshness_opportunity.requested` and `.our_own_article`.
  'freshness_opportunity.refresh',
  // Written by the existing-target check when a weak page of the merchant's own
  // covers part of a search, and rendered on the opportunity card. No sentence
  // anywhere, and no dot in the key — so it is not even shaped like one the
  // catalogue could hold.
  'existing_target_weak_match_link',
  // The manual-topic path's own.
  'topic.manual',
]

/**
 * A key resolves when **the renderer** can find a sentence for it. `hasCopy` is
 * that same lookup and nothing else: it tries the key's own family, follows the
 * aliases, and otherwise reaches for `template.<key>`.
 *
 * It used to also pass a key that merely existed in the catalogue under its bare
 * name, whether or not the renderer could reach it. That second route was the
 * whole fault: eight sentences were written, spelled correctly, and filed in
 * families the lookup had never been told about, so the guard was satisfied
 * while the merchant read "the reasoning for this one isn't available yet". A
 * check that asks the catalogue is a spelling check; a check that asks the
 * renderer is a check that the sentence arrives.
 *
 * The cost of the stricter rule is that a family of finished keys nothing has
 * declared fails here. That is the point — the fix is one line naming the family
 * in the renderer, and the failure says which key and which file asked for it.
 */
function resolves(key: string): boolean {
  return hasCopy(key)
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRECTORIES.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

interface Sighting {
  readonly key: string
  readonly where: string
}

function everyWrittenKey(): readonly Sighting[] {
  const out: Sighting[] = []
  for (const root of SEARCH_ROOTS) {
    for (const file of sourceFiles(join(repoRoot, root))) {
      const text = readFileSync(file, 'utf8')
      const lines = text.split('\n')
      for (const [index, line] of lines.entries()) {
        for (const match of line.matchAll(KEY_FIELDS)) {
          out.push({ key: match[1]!, where: `${relative(repoRoot, file)}:${index + 1}` })
        }
      }
    }
  }
  return out
}

describe('the explanation keys written by hand across the repository', () => {
  const sightings = everyWrittenKey()

  it('finds them at all, or every check below is vacuous', () => {
    expect(sightings.length).toBeGreaterThan(50)
    expect(sightings.map((sighting) => sighting.key)).toContain('uncovered_commercial_query.create')
  })

  it('every one renders as a sentence rather than as the renderer giving up', () => {
    const known = new Set([...DELIBERATELY_UNKNOWN, ...AWAITING_ANOTHER_LANE])
    const orphans = sightings.filter(
      (sighting) => !known.has(sighting.key) && !resolves(sighting.key),
    )

    expect(
      orphans.map((sighting) => `${sighting.key} (${sighting.where})`),
      'these name an explanation the renderer cannot find — write the sentence, name the key the engine really builds, or tell the renderer about the family this key belongs to',
    ).toEqual([])
  })

  it('keeps the outstanding list honest — a key that has been written stops being outstanding', () => {
    const resolved = AWAITING_ANOTHER_LANE.filter((key) => resolves(key))
    expect(
      resolved,
      `these now resolve and should come off AWAITING_ANOTHER_LANE: ${resolved.join(', ')}`,
    ).toEqual([])
  })

  /**
   * The check above is only worth its runtime if it can say no, and there are
   * two ways for it to stop being able to. One is a key with no sentence
   * anywhere. The other is subtler and is the one that already happened: a
   * sentence that exists in the catalogue under a name the renderer has no way
   * to reach, which for a whole year looked identical to a working screen.
   */
  it('can still say no — to a key with no sentence, and to one the renderer cannot reach', () => {
    for (const key of DELIBERATELY_UNKNOWN) {
      expect(resolves(key), `${key} is supposed to be unresolvable`).toBe(false)
    }

    // A real sentence, under a real catalogue key, in a family nobody has told
    // the renderer about. This is exactly the shape of the eight keys that were
    // reaching merchants as "the reasoning for this one isn't available yet",
    // and the guard has to refuse it rather than be satisfied that the words
    // exist somewhere.
    expect(resolves('nav.dashboard')).toBe(false)
  })

  it('keeps the outstanding list from outliving the fixtures on it', () => {
    const written = new Set(sightings.map((sighting) => sighting.key))
    const gone = [...DELIBERATELY_UNKNOWN, ...AWAITING_ANOTHER_LANE].filter(
      (key) => !written.has(key),
    )
    expect(
      gone,
      `nothing names these any more, so they should come off the lists: ${gone.join(', ')}`,
    ).toEqual([])
  })
})
