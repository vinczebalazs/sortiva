import { describe, expect, it } from 'vitest'
import {
  analyseCoverage,
  buildCoverageRequest,
  gapSet,
  groundSubtopics,
  type CoverageAnalysisInput,
  type CoverageAnalysisOutput,
  type CoverageCompetitorPage,
} from './coverage'
import { StubLlmClient } from './testing/stub-llm-client'

/**
 * The comparison call and the two filters around it. Worked example 4 (main
 * §7.8): a collection at #11 for "waterproof hiking boots", where the pages
 * above it all settle waterproofing, terrain, fit and sizing and ours settles
 * none of them.
 */

const PROMPT = { version: 'intent-gap.v1', text: 'compare the pages' }

function competitor(url: string, position: number): CoverageCompetitorPage {
  return {
    url,
    domain: new URL(url).hostname,
    position,
    title: `Best waterproof hiking boots ${position}`,
    headings: ['Waterproofing', 'Terrain', 'Fit and sizing'],
    excerpt: 'Gore-Tex membranes keep water out on wet ground.',
  }
}

const COMPETITORS = [
  competitor('https://outdoorgearlab.example/hiking-boots', 1),
  competitor('https://switchbacktravel.example/best-hiking-boots', 2),
  competitor('https://rei.example/learn/hiking-boots', 3),
  competitor('https://trailspace.example/boots', 4),
  competitor('https://bootguide.example/waterproof', 5),
]

const ANALYSIS_INPUT: CoverageAnalysisInput = {
  accountId: '11111111-1111-4111-8111-111111111111',
  query: 'waterproof hiking boots',
  ourPage: {
    url: 'https://shop.example/collections/hiking-boots',
    title: 'Hiking boots',
    headings: ['Our range'],
    excerpt: 'Browse our hiking boots.',
  },
  competitors: COMPETITORS,
}

function citing(urls: readonly string[], heading = 'Waterproofing') {
  return urls.map((url) => ({ url, heading }))
}

describe('the subtopic coverage request', () => {
  it('runs as the intent_gap call type, carries every fetched page, and names our page separately', () => {
    const request = buildCoverageRequest({ prompt: PROMPT, analysis: ANALYSIS_INPUT })

    expect(request.callType).toBe('intent_gap')
    expect(request.promptVersion).toBe('intent-gap.v1')
    expect(request.system).toBe('compare the pages')

    const content = request.messages[0]!.content
    expect(content).toContain('Our page — https://shop.example/collections/hiking-boots')
    for (const page of COMPETITORS) expect(content).toContain(page.url)
    // The merchant's catalogue is not part of a coverage comparison; nothing
    // from it should ever reach this prompt.
    expect(content).not.toContain('fact sheet')
  })

  it('validates the answer against a schema, so a shape we cannot read is a typed failure rather than a half-parsed object', () => {
    expect(buildCoverageRequest({ prompt: PROMPT, analysis: ANALYSIS_INPUT }).schema).toBeDefined()
  })
})

describe('grounding the answer in the pages we actually fetched', () => {
  it('drops an address the model was never given, and the subtopic with it when nothing is left', () => {
    const output: CoverageAnalysisOutput = {
      subtopics: [
        {
          name: 'waterproofing',
          presentOnOurPage: false,
          ourEvidence: null,
          competitors: [
            { url: 'https://invented.example/never-fetched', heading: 'Waterproofing' },
            { url: COMPETITORS[0]!.url, heading: 'Waterproofing' },
          ],
        },
        {
          name: 'resale value',
          presentOnOurPage: false,
          ourEvidence: null,
          competitors: [{ url: 'https://also-invented.example/x', heading: 'Resale' }],
        },
      ],
    }

    const grounded = groundSubtopics(output, COMPETITORS)

    expect(grounded).toHaveLength(1)
    expect(grounded[0]!.name).toBe('waterproofing')
    expect(grounded[0]!.competitors.map((c) => c.url)).toEqual([COMPETITORS[0]!.url])
  })

  it('counts one ranking page once, however many times it was cited', () => {
    const output: CoverageAnalysisOutput = {
      subtopics: [
        {
          name: 'terrain',
          presentOnOurPage: false,
          ourEvidence: null,
          competitors: [
            { url: COMPETITORS[0]!.url, heading: 'Terrain' },
            { url: COMPETITORS[0]!.url, heading: 'Trail types' },
          ],
        },
      ],
    }

    expect(groundSubtopics(output, COMPETITORS)[0]!.competitors).toHaveLength(1)
  })
})

describe('the gap set', () => {
  const subtopics = groundSubtopics(
    {
      subtopics: [
        // On three of the five, absent from ours — a gap.
        {
          name: 'waterproofing',
          presentOnOurPage: false,
          ourEvidence: null,
          competitors: citing(COMPETITORS.slice(0, 3).map((c) => c.url)),
        },
        // On four, absent from ours — a gap.
        {
          name: 'sizing',
          presentOnOurPage: false,
          ourEvidence: null,
          competitors: citing(COMPETITORS.slice(0, 4).map((c) => c.url), 'Fit and sizing'),
        },
        // On only two — one page's hobby-horse, not a gap.
        {
          name: 'resoling cost',
          presentOnOurPage: false,
          ourEvidence: null,
          competitors: citing(COMPETITORS.slice(0, 2).map((c) => c.url), 'Resoling'),
        },
        // On four, but ours covers it — not a gap.
        {
          name: 'materials',
          presentOnOurPage: true,
          ourEvidence: 'Our range',
          competitors: citing(COMPETITORS.slice(0, 4).map((c) => c.url), 'Materials'),
        },
      ],
    },
    COMPETITORS,
  )

  it('keeps only what enough of the ranking pages settle and ours does not', () => {
    expect(gapSet(subtopics, 3).map((s) => s.name)).toEqual(['waterproofing', 'sizing'])
  })

  it('is re-derived at the floor it is handed, so raising the consensus bar narrows the set', () => {
    expect(gapSet(subtopics, 4).map((s) => s.name)).toEqual(['sizing'])
  })
})

describe('the analysis end to end', () => {
  it('hands the raw answer to the caller before deriving anything from it', async () => {
    const llm = new StubLlmClient({
      subtopics: [
        {
          name: 'waterproofing',
          presentOnOurPage: false,
          ourEvidence: null,
          competitors: citing(COMPETITORS.slice(0, 3).map((c) => c.url)),
        },
      ],
    } satisfies CoverageAnalysisOutput)

    const seen: CoverageAnalysisOutput[] = []
    const analysis = await analyseCoverage({ llm, prompt: PROMPT }, ANALYSIS_INPUT, async (raw) => {
      seen.push(raw)
    })

    expect(seen).toHaveLength(1)
    expect(seen[0]!.subtopics[0]!.name).toBe('waterproofing')
    expect(analysis.topPagesAnalysed).toBe(5)
    expect(analysis.subtopics.map((s) => s.name)).toEqual(['waterproofing'])
    expect(llm.requests).toHaveLength(1)
    expect(llm.requests[0]!.callType).toBe('intent_gap')
  })
})
