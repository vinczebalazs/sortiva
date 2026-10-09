import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { approveArticle, articleDetail, articlesState, discardArticle, exportBundle, setPublishedUrl } from '../../core/articles.ts'
import { homeState } from '../../core/screens.ts'
import { startPipeline, type Pipeline } from '../pipeline.ts'
import { articlesOf, cleanDraft, resetDay, seedDraft } from './seed.ts'

let p: Pipeline
let storeId: number

beforeAll(async () => {
  p = await startPipeline()
  storeId = (await p.install('rich-hu')).id
  await p.settle()
  await p.completeSetup(storeId)
  await p.settle(300_000)
  await p.db.pool.query(`update stores set review_first = true where id = $1`, [storeId])
}, 600_000)
afterAll(() => p?.stop())

// The article is the clean recorded draft, so these scenarios are about review and export, not about how the writer did today.
async function writeOne() {
  await resetDay(p, storeId)
  const { rows } = await p.db.pool.query<{ target_query: string }>(
    `select target_query from topics where store_id = $1 and state = 'queued' order by manual_position asc nulls last, rank desc, id limit 1`,
    [storeId],
  )
  seedDraft(p, 'hu', rows[0]!.target_query, cleanDraft('rich-hu-zold-tea'))
  await p.writeToday(storeId)
  await p.settle(900_000)
  const [article] = await articlesOf(p, storeId)
  return article!
}

describe('review first (Hungarian rich shop)', () => {
  it('a written article waits for review, Home shows it, and approving makes it ready', async () => {
    const article = await writeOne()
    expect(article.state, JSON.stringify(article.gate_report.heldProblem)).toBe('awaiting_review')

    const home = await homeState(p.db.pool, storeId)
    expect(home.today).toMatchObject({ kind: 'scheduled', decided: true, articles: [{ id: article.id, status: 'awaiting_review' }] })

    const detail = (await articleDetail(p.db.pool, storeId, article.id))!
    expect(detail.language).toBe('hu')
    expect(detail.checks.every((c) => c.ok)).toBe(true)
    expect(detail.checks.map((c) => c.id)).toContain('review')
    expect(detail.scores!.grounding).toBeGreaterThanOrEqual(4)
    // Every fact the article relies on is one of this store's facts, shown with its product.
    expect(detail.facts.length).toBeGreaterThanOrEqual(6)
    const { rows } = await p.db.pool.query(`select count(*)::int as n from product_facts where store_id = $1 and id = any($2::bigint[])`, [storeId, detail.facts.map((f) => f.id)])
    expect(rows[0].n).toBe(detail.facts.length)
    expect(detail.html).toContain('<h2>')
    expect(detail.html).not.toMatch(/\[(F\d+|G)\]/)

    // Not downloadable before approval.
    expect(await exportBundle(p.db.pool, storeId, article.id)).toBeNull()
    expect(await approveArticle(p.db.pool, storeId, article.id)).toBe(true)
    expect(await approveArticle(p.db.pool, storeId, article.id)).toBe(false)
    expect((await articleDetail(p.db.pool, storeId, article.id))!.status).toBe('ready')
  }, 900_000)

  it('the export is a zip with the Markdown, the HTML and the metadata; downloading marks it exported', async () => {
    const [article] = await articlesOf(p, storeId)
    const bundle = (await exportBundle(p.db.pool, storeId, article!.id))!
    const dir = mkdtempSync(join(tmpdir(), 'sortiva-export-'))
    const file = join(dir, bundle.filename)
    writeFileSync(file, bundle.bytes)
    execFileSync('unzip', ['-q', file, '-d', dir])
    const slug = bundle.filename.replace(/\.zip$/, '')
    const listing = execFileSync('unzip', ['-Z1', file]).toString().trim().split('\n').sort()
    expect(listing).toEqual([`${slug}.html`, `${slug}.json`, `${slug}.md`])
    const metadata = JSON.parse(execFileSync('cat', [join(dir, `${slug}.json`)]).toString())
    expect(metadata).toMatchObject({ slug, language: 'hu' })
    expect(metadata.target_query).toBeTruthy()
    expect(metadata.meta_description.length).toBeGreaterThan(50)
    for (const url of metadata.image_urls) expect(url).toMatch(/^https:\/\/cdn\.shopify\.com\//)

    expect((await articleDetail(p.db.pool, storeId, article!.id))!.status).toBe('exported')
    // It can be downloaded again.
    expect(await exportBundle(p.db.pool, storeId, article!.id)).not.toBeNull()
  })

  it('"Where did you publish it?" accepts only an address on the store\'s own domain', async () => {
    const [article] = await articlesOf(p, storeId)
    expect((await articlesState(p.db.pool, storeId)).articles[0]).toMatchObject({ id: article!.id, status: 'exported', askForUrl: true })
    expect(await setPublishedUrl(p.db.pool, storeId, article!.id, 'https://example.com/blogs/news/tea')).toBe('invalid')
    expect(await setPublishedUrl(p.db.pool, storeId, article!.id, 'not a url')).toBe('invalid')
    const { rows } = await p.db.pool.query(`select storefront_host from stores where id = $1`, [storeId])
    expect(await setPublishedUrl(p.db.pool, storeId, article!.id, `https://${rows[0].storefront_host}/blogs/hirek/zold-tea?utm_source=x`)).toBe('ok')
    const row = (await articlesState(p.db.pool, storeId)).articles[0]!
    expect(row.askForUrl).toBe(false)
    expect(row.publishedUrl).toBe(`https://${rows[0].storefront_host}/blogs/hirek/zold-tea`)
  })

  it('discarding marks the topic not interested and removes the article from the list', async () => {
    const article = await writeOne()
    expect(article.state).toBe('awaiting_review')
    expect(await discardArticle(p.db.pool, storeId, article.id)).toBe(true)
    const { rows } = await p.db.pool.query(
      `select t.state, exists (select 1 from not_interested n where n.store_id = t.store_id and n.canonical_key = t.canonical_key) as vetoed
       from topics t where t.id = $1`,
      [article.topic_id],
    )
    expect(rows[0]).toEqual({ state: 'vetoed', vetoed: true })
    expect((await articlesState(p.db.pool, storeId)).articles).toEqual([])
    expect(await articleDetail(p.db.pool, storeId, article.id)).toBeNull()
  }, 900_000)
})
