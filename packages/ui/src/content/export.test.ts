import { describe, expect, it } from 'vitest'
import { fetchArticleExport } from './export'
import { t } from '../strings'

/**
 * What a merchant is handed, and what they are told when they cannot be handed
 * anything.
 *
 * No test covered the download buttons at all before this card, which is why
 * both screens could build their files from a response that answers with an
 * empty body by design and nobody noticed. These stand in for the merchant's
 * side of that: what the screen does with each answer the route can give.
 */

function respondWith(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
}

describe('asking the export route for an article’s files', () => {
  it('asks the export address, not the article address', async () => {
    let asked = ''
    const spy = (async (url: string) => {
      asked = url
      return new Response(JSON.stringify({ files: [] }), { status: 200 })
    }) as unknown as typeof fetch

    await fetchArticleExport('art-1', t, spy)

    // The whole card: the detail endpoint answers 200 with an empty body when
    // an article cannot be rendered, so building a download from it hands over
    // a title and nothing else.
    expect(asked).toBe('/api/articles/art-1/export')
  })

  it('hands back the files the route built', async () => {
    const files = [{ filename: 'sortiva-a.md', mimeType: 'text/markdown', content: '# A' }]
    const result = await fetchArticleExport('art-1', t, respondWith(200, { files }))

    expect(result).toEqual({ ok: true, files })
  })

  it('carries the route’s own reason when it refuses', async () => {
    const message = t('content.articles.export.productGone')
    const result = await fetchArticleExport(
      'art-1',
      t,
      respondWith(409, { error: { code: 'bundle_not_buildable', message } }),
    )

    expect(result.ok).toBe(false)
    // The merchant is told which situation they are in, rather than handed an
    // empty document or a generic failure.
    expect(result.ok === false && result.message).toBe(message)
    expect(result.ok === false && result.message).toContain('no longer has')
  })

  it('still says something when the route refuses without a sentence', async () => {
    const result = await fetchArticleExport('art-1', t, respondWith(500, {}))

    expect(result).toEqual({ ok: false, message: t('content.articles.export.failed') })
  })

  it('says something when the request cannot be made at all', async () => {
    const broken = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch

    const result = await fetchArticleExport('art-1', t, broken)

    expect(result).toEqual({ ok: false, message: t('content.articles.export.failed') })
  })
})
