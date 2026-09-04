import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildConsolidationRecommendation } from './consolidation'
import { renderConsolidationView } from './view'

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..')
const catalogue = JSON.parse(
  readFileSync(join(repoRoot, 'packages', 'ui', 'strings', 'en.json'), 'utf8'),
) as Record<string, string>

function recommendation(sameKind: boolean) {
  return buildConsolidationRecommendation({
    clusterHead: 'trail running shoes',
    competing: [
      { url: '/collections/a', pageType: 'collection', impressionShare: 0.6, position: 8 },
      {
        url: sameKind ? '/collections/b' : '/products/b',
        pageType: sameKind ? 'collection' : 'product',
        impressionShare: 0.4,
        position: 11,
      },
    ],
    inventory: [{ url: '/pages/x', outboundInternalLinks: [sameKind ? '/collections/b' : '/products/b'] }],
  })
}

describe('the FIX recommendation as the drawer shows it', () => {
  it('sends keys and numbers, never sentences — the words live in the catalogue', () => {
    const view = renderConsolidationView(recommendation(true))
    const text = JSON.stringify(view)
    expect(text).not.toContain('Google already shows')
    expect(text).not.toContain('Sortiva does not change')
  })

  it('names a key the string catalogue actually holds, everywhere it names one', () => {
    for (const sameKind of [true, false]) {
      const view = renderConsolidationView(recommendation(sameKind))
      const keys = [
        view.trustLineKey,
        ...view.sections.flatMap((section) => [
          section.headingKey,
          ...section.lines.map((line) => line.templateKey),
        ]),
      ]
      for (const key of keys) {
        expect(catalogue[key], `packages/ui/strings/en.json has no "${key}"`).toBeDefined()
      }
    }
  })

  it('fills every placeholder the sentence it names asks for', () => {
    const view = renderConsolidationView(recommendation(false))
    for (const section of view.sections) {
      for (const line of section.lines) {
        const template = catalogue[line.templateKey] as string
        for (const [, name] of template.matchAll(/\{(\w+)\}/g)) {
          expect(line.params[name as string], `"${line.templateKey}" needs {${name}}`).toBeDefined()
        }
      }
    }
  })

  it('says so out loud when we hold no record of a link into the demoted pages', () => {
    const view = renderConsolidationView(
      buildConsolidationRecommendation({
        clusterHead: 'q',
        competing: [
          { url: '/collections/a', pageType: 'collection', impressionShare: 0.6, position: 8 },
          { url: '/collections/b', pageType: 'collection', impressionShare: 0.4, position: 11 },
        ],
      }),
    )
    const links = view.sections.find((section) => section.kind === 'internal_links')
    expect(links?.lines.map((line) => line.templateKey)).toEqual(['fix.consolidation.links.none'])
  })
})
