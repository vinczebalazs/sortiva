import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { t } from '../strings'
import {
  articleActions,
  articleCounts,
  articleEventLabel,
  articleFilename,
  articleFiles,
  articleMarkdown,
  articleMetadataBlock,
  checkPublishedUrl,
  criterionLabel,
  failingCriteria,
  filterArticles,
  needsAttention,
} from './articles'
import { articleConflictKey } from './ArticleDetail'
import type { ArticleDetailResponse, ArticleSummary } from './types'

/**
 * The library's rules, and the one absence the product is committed to.
 *
 * The absence is the article editor. There isn't one, deliberately: review is a
 * single decision rather than a writing surface, and "we never built it" and "we
 * decided against it" look identical in a codebase until something asserts the
 * difference. The last block here reads the two components that render an
 * article and fails if either grows a textarea, an editable region or an input
 * over the body.
 */

const here = dirname(fileURLToPath(import.meta.url))

function article(overrides: Partial<ArticleSummary> = {}): ArticleSummary {
  return {
    id: 'article-1',
    title: 'Best trail running shoes for wide feet',
    state: 'published',
    delivery: 'auto',
    publishedAt: '2026-08-15T09:00:00.000Z',
    publishedUrl: 'https://example-outdoor.com/blogs/guides/wide-fit',
    publishedViaOverride: false,
    repaired: false,
    refreshedCount: 0,
    performance: null,
    ...overrides,
  }
}

function detail(overrides: Partial<ArticleDetailResponse> = {}): ArticleDetailResponse {
  return {
    article: article(),
    html: '<h1>Wide-fit trail shoes</h1><p>Under eighty pounds you are choosing.</p><ul><li>Lug depth</li></ul>',
    metadata: {
      targetKeyword: 'trail shoes wide feet',
      slug: 'wide-fit-trail-shoes',
      metaDescription: 'How to choose trail shoes when standard widths pinch.',
      familyIds: ['trail-running'],
      opportunityId: 'opp-1',
    },
    evidencePack: [{ productId: 'trail-1', title: 'Trail Running 1' }],
    qualityReport: {
      scores: { informationGain: 2, factualGrounding: 5, structure: 4 },
      justifications: { informationGain: 'Repeats what the ranking pages already say.' },
      promptVersion: 'judge.v1',
      modelId: 'claude-sonnet-5',
      passed: false,
    },
    history: [{ at: '2026-08-15T09:00:00.000Z', event: 'published' }],
    ...overrides,
  }
}

describe('which articles are waiting on the merchant', () => {
  it('counts a draft nobody has read and one held back', () => {
    expect(needsAttention(article({ state: 'in_review' }))).toBe(true)
    expect(needsAttention(article({ state: 'rejected' }))).toBe(true)
  })

  it('counts an exported article whose address we were never told', () => {
    expect(
      needsAttention(article({ delivery: 'export', publishedUrl: null })),
    ).toBe(true)
  })

  it('leaves an auto-published article alone, because nothing is outstanding on it', () => {
    expect(needsAttention(article())).toBe(false)
    // An auto-published article has no URL to paste, so a null one is not a task.
    expect(needsAttention(article({ publishedUrl: null }))).toBe(false)
  })
})

describe('filters', () => {
  const rows = [
    article({ id: 'a', state: 'published', performance: { clicks28d: 41, position: 12, trend: 'up', label: 'winner' } }),
    article({ id: 'b', state: 'in_review', publishedAt: null, publishedUrl: null }),
    article({ id: 'c', state: 'rejected', publishedAt: null, publishedUrl: null }),
  ]

  it('leaves everything alone when nothing is chosen', () => {
    expect(filterArticles(rows, {})).toHaveLength(3)
  })

  it('narrows to one state', () => {
    expect(filterArticles(rows, { states: ['rejected'] }).map((row) => row.id)).toEqual(['c'])
  })

  it('narrows to the ones with a measured result', () => {
    expect(filterArticles(rows, { hasPerformance: true }).map((row) => row.id)).toEqual(['a'])
  })

  it('narrows to the ones waiting on the merchant', () => {
    expect(filterArticles(rows, { needsAttention: true }).map((row) => row.id)).toEqual(['b', 'c'])
  })

  it('counts the states without ever framing them against a total', () => {
    expect(articleCounts(rows)).toEqual({ published: 1, inReview: 1, held: 1 })
    expect(t('content.articles.counts', { published: 1, inReview: 1, held: 1 })).not.toMatch(
      /\d+\s*(of|\/)\s*\d+/,
    )
  })
})

describe('the address of an exported article', () => {
  const domain = 'example-outdoor.com'

  it('accepts one on the claimed domain', () => {
    expect(checkPublishedUrl('https://example-outdoor.com/blogs/a', domain)).toEqual({
      ok: true,
      url: 'https://example-outdoor.com/blogs/a',
    })
  })

  it('accepts a subdomain, because a store blog often lives on one', () => {
    expect(checkPublishedUrl('https://blog.example-outdoor.com/a', domain).ok).toBe(true)
  })

  it('ignores a leading www on either side', () => {
    expect(checkPublishedUrl('https://www.example-outdoor.com/a', domain).ok).toBe(true)
  })

  it('refuses another site, which is the failure that would steal somebody else’s numbers', () => {
    expect(checkPublishedUrl('https://competitor.example/a', domain)).toEqual({
      ok: false,
      problem: 'off_domain',
    })
  })

  it('refuses a lookalike domain that merely ends in the claimed one', () => {
    expect(checkPublishedUrl('https://notexample-outdoor.com/a', domain).problem).toBe('off_domain')
  })

  it('refuses something that is not a web address at all', () => {
    expect(checkPublishedUrl('blogs/a', domain).problem).toBe('malformed')
    expect(checkPublishedUrl('javascript:alert(1)', domain).problem).toBe('malformed')
  })
})

describe('the criteria an override has to restate', () => {
  it('names the ones the judge wrote an objection about', () => {
    expect(failingCriteria(detail().qualityReport)).toEqual(['informationGain'])
  })

  it('names every scored criterion rather than none when the judge explained nothing', () => {
    const report = { ...detail().qualityReport!, justifications: {} }
    expect(failingCriteria(report)).toEqual(['informationGain', 'factualGrounding', 'structure'])
  })

  it('compares nothing to a floor, so the quality gate stays in one place', () => {
    const source = readFileSync(join(here, 'articles.ts'), 'utf8')
    // A threshold in a browser is a second copy of the gate that nothing stamps
    // with a rules version. There must be no comparison against a score here.
    expect(source).not.toMatch(/score\s*[<>]=?\s*\d/)
    expect(source).not.toMatch(/\b(informationGain|factualGrounding)\s*[<>]=?/)
  })

  it('turns a criterion name into words, and spells out one it has never heard of', () => {
    expect(criterionLabel('informationGain')).toBe('Information gain')
    expect(criterionLabel('narrative_flow')).toBe('Narrative flow')
  })
})

describe('what leaves the screen as a file', () => {
  it('produces Markdown, HTML and the metadata block', () => {
    const files = articleFiles(detail())
    expect(files.map((file) => file.mimeType)).toEqual([
      'text/markdown',
      'text/html',
      'application/json',
    ])
  })

  it('keeps the article’s structure in the Markdown rather than flattening it', () => {
    const markdown = articleMarkdown(detail())
    expect(markdown).toContain('# Wide-fit trail shoes')
    expect(markdown).toContain('- Lug depth')
    expect(markdown).not.toContain('<p>')
  })

  it('carries every field an export merchant has to set by hand', () => {
    const block = JSON.parse(articleMetadataBlock(detail())) as Record<string, unknown>
    expect(Object.keys(block).sort()).toEqual([
      'families',
      'metaDescription',
      'products',
      'slug',
      'targetKeyword',
      'title',
    ])
  })

  it('makes a filename that survives every operating system', () => {
    expect(articleFilename('Best shoes: under £80 / wide!', 'md')).toBe(
      'sortiva-best-shoes-under-80-wide.md',
    )
  })
})

describe('the action bar a state earns', () => {
  it('offers one decision on a draft under review, and no third option', () => {
    expect(articleActions(article({ state: 'in_review' }))).toEqual(['approve', 'discard'])
  })

  it('keeps the override available on a held draft, because it is the merchant’s site', () => {
    expect(articleActions(article({ state: 'rejected' }))).toContain('publish_anyway')
  })

  it('asks an export merchant for the address and an auto one for nothing', () => {
    expect(articleActions(article({ delivery: 'export' }))).toContain('confirm_url')
    expect(articleActions(article({ delivery: 'auto' }))).not.toContain('confirm_url')
  })

  it('never offers an edit, in any state', () => {
    for (const state of ['draft', 'in_review', 'published', 'rejected', 'discarded'] as const) {
      for (const delivery of ['export', 'auto'] as const) {
        expect(articleActions(article({ state, delivery })).join()).not.toContain('edit')
      }
    }
  })
})

describe('a refused article action', () => {
  it('says which thing moved rather than failing silently', () => {
    expect(t(articleConflictKey('article_not_in_review'))).toBe(
      t('content.article.toast.notInReview'),
    )
    expect(t(articleConflictKey('refresh_within_cooldown'))).toBe(
      t('content.article.toast.cooldown'),
    )
    expect(t(articleConflictKey(null))).toBe(t('content.toast.failed'))
  })
})

describe('history', () => {
  it('names the events it knows and spells out the ones it does not', () => {
    expect(articleEventLabel('published')).toBe('Published')
    expect(articleEventLabel('sent_to_shopify')).toBe('Sent to shopify')
  })
})

describe('there is no editor, and that is a decision rather than an omission', () => {
  const sources = ['ArticleDetail.tsx', 'ArticlesScreen.tsx', 'PublishedUrlField.tsx'].map(
    (name) => [name, readFileSync(join(here, name), 'utf8')] as const,
  )

  it('renders no textarea and no editable region anywhere an article is shown', () => {
    for (const [name, source] of sources) {
      expect(source, name).not.toMatch(/<textarea/i)
      expect(source, name).not.toMatch(/contentEditable/i)
      expect(source, name).not.toMatch(/designMode/i)
    }
  })

  it('has exactly one text input in the module, and it is the published address', () => {
    const detailSource = sources.find(([name]) => name === 'ArticleDetail.tsx')![1]
    expect(detailSource).not.toMatch(/<input/i)
    const urlSource = sources.find(([name]) => name === 'PublishedUrlField.tsx')![1]
    expect(urlSource.match(/<input/gi) ?? []).toHaveLength(1)
    expect(urlSource).toContain('published-url-')
  })

  it('names no save-the-body action, which is what an editor would need', () => {
    for (const [name, source] of sources) {
      expect(source, name).not.toMatch(/\/(save|edit|update)-?(body|content|html)/i)
    }
  })
})
