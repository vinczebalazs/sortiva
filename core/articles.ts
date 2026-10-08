import type { Db } from '../db/pool.ts'
import { zip } from './deliver/zip.ts'
import type { Evidence } from './topics/evidence.ts'
import { whyLine, type WhyLine } from './topics/evidence.ts'
import type { CheckId, Problem } from './write/checks.ts'
import type { GateReport, HeldReason, Scores } from './write/write.ts'

export type ArticleStatus = 'writing' | 'held' | 'awaiting_review' | 'ready' | 'exported' | 'published' | 'draft_in_shopify' | 'removed_by_merchant'

export type ArticleRow = {
  id: number
  title: string
  writtenAt: string | null
  status: ArticleStatus
  publishedUrl: string | null
  /** Exported and its address unknown: the row asks "Where did you publish it?". */
  askForUrl: boolean
  results: { clicks: number; impressions: number; label: 'above' | 'typical' | 'below' | null } | null
}

export type ArticlesState = { limited: boolean; deliveryMode: 'export' | 'auto_publish'; articles: ArticleRow[] }

export async function articlesState(db: Db, storeId: number, status?: ArticleStatus): Promise<ArticlesState> {
  const { rows: store } = await db.query<{ delivery_mode: 'export' | 'auto_publish'; limited: boolean }>(
    `select delivery_mode, not exists (select 1 from gsc_connections g where g.store_id = s.id and g.connected_at is not null and g.disconnected_at is null) as limited
     from stores s where id = $1`,
    [storeId],
  )
  const { rows } = await db.query<{
    id: number
    title: string | null
    written_at: Date | null
    state: ArticleStatus
    published_url: string | null
    clicks: number | null
    impressions: number | null
    label: 'above' | 'typical' | 'below' | null
  }>(
    `select a.id::int, a.title, a.written_at, a.state, a.published_url, m.clicks, m.impressions, m.label
     from articles a
     left join lateral (select clicks, impressions, label from article_metrics where article_id = a.id order by window_end desc limit 1) m on true
     where a.store_id = $1 and a.state not in ('discarded', 'writing') and ($2::text is null or a.state = $2)
     order by a.written_at desc nulls last, a.id desc`,
    [storeId, status ?? null],
  )
  return {
    limited: store[0]!.limited,
    deliveryMode: store[0]!.delivery_mode,
    articles: rows.map((r) => ({
      id: r.id,
      title: r.title ?? '',
      writtenAt: r.written_at?.toISOString() ?? null,
      status: r.state,
      publishedUrl: r.published_url,
      askForUrl: r.state === 'exported' && !r.published_url,
      results: r.clicks === null ? null : { clicks: r.clicks, impressions: r.impressions ?? 0, label: r.label },
    })),
  }
}

export type CheckLine = { id: CheckId | 'review'; ok: boolean; problem: Problem | null }

export type ArticleDetail = {
  id: number
  title: string
  status: ArticleStatus
  language: 'en' | 'hu'
  metaDescription: string | null
  slug: string | null
  html: string | null
  markdown: string | null
  writtenAt: string | null
  publishedUrl: string | null
  deliveryMode: 'export' | 'auto_publish'
  topic: { targetQuery: string; searches: number | null; why: WhyLine }
  products: { id: number; platformId: string; title: string; url: string | null; gone: boolean }[]
  facts: { id: number; text: string; product: string }[]
  /** Failed checks first, as the Article page shows them. */
  checks: CheckLine[]
  scores: Scores | null
  heldReason: HeldReason | null
  heldProblem: Problem | null
}

export async function articleDetail(db: Db, storeId: number, articleId: number): Promise<ArticleDetail | null> {
  const { rows } = await db.query<{
    id: number
    title: string | null
    state: ArticleStatus | 'discarded'
    language: 'en' | 'hu'
    meta_description: string | null
    slug: string | null
    html: string | null
    markdown: string | null
    written_at: Date | null
    published_url: string | null
    delivery_mode: 'export' | 'auto_publish'
    product_ids: number[]
    claims: { facts: number[] }[]
    gate_report: GateReport | Record<string, never>
    target_query: string
    demand: number | null
    evidence: Evidence
    source: 'discovery' | 'manual'
  }>(
    `select a.id::int, a.title, a.state, a.language, a.meta_description, a.slug, a.html, a.markdown, a.written_at, a.published_url,
            s.delivery_mode, a.product_ids::int[], a.claims, a.gate_report, t.target_query, t.demand, t.evidence, t.source
     from articles a join topics t on t.id = a.topic_id join stores s on s.id = a.store_id
     where a.id = $1 and a.store_id = $2 and a.state <> 'discarded'`,
    [articleId, storeId],
  )
  const a = rows[0]
  if (!a || a.state === 'discarded') return null
  const { rows: products } = await db.query<ArticleDetail['products'][number]>(
    `select id::int, platform_id as "platformId", title, online_store_url as url, deleted_at is not null as gone
     from products where id = any($1::bigint[]) order by array_position($1::bigint[], id)`,
    [a.product_ids],
  )
  const factIds = [...new Set(a.claims.flatMap((c) => c.facts))]
  const { rows: facts } = await db.query<ArticleDetail['facts'][number]>(
    `select f.id::int, f.fact as text, p.title as product from product_facts f join products p on p.id = f.product_id
     where f.id = any($1::bigint[]) order by p.id, f.id`,
    [factIds],
  )
  const report = 'attempts' in a.gate_report ? a.gate_report : null
  const last = report?.attempts.at(-1) ?? null
  const checks: CheckLine[] = last
    ? [
        ...last.mechanical.checks.map((c) => ({ id: c.id, ok: c.ok, problem: c.problems[0] ?? null })),
        ...(last.judge ? [{ id: 'review' as const, ok: last.judge.passed, problem: last.judge.passed ? null : (last.judge.problems[0] ?? null) }] : []),
      ].sort((x, y) => Number(x.ok) - Number(y.ok))
    : []
  return {
    id: a.id,
    title: a.title ?? '',
    status: a.state,
    language: a.language,
    metaDescription: a.meta_description,
    slug: a.slug,
    html: a.html,
    markdown: a.markdown,
    writtenAt: a.written_at?.toISOString() ?? null,
    publishedUrl: a.published_url,
    deliveryMode: a.delivery_mode,
    topic: { targetQuery: a.target_query, searches: a.demand, why: whyLine(a.evidence, a.source) },
    products,
    facts,
    checks,
    scores: last?.judge?.scores ?? null,
    heldReason: report?.heldReason ?? null,
    heldProblem: report?.heldProblem ?? null,
  }
}

/** "Approve": the article is ready to go out (export: download now; auto-publish: at the next publish hour, phase 4). */
export async function approveArticle(db: Db, storeId: number, articleId: number): Promise<boolean> {
  const { rowCount } = await db.query(
    `update articles set state = 'ready', approved_at = now() where id = $1 and store_id = $2 and state = 'awaiting_review'`,
    [articleId, storeId],
  )
  return Boolean(rowCount)
}

/** "Discard": the article is dropped and its topic goes on the not-interested list, so it is never proposed again. */
export async function discardArticle(db: Db, storeId: number, articleId: number): Promise<boolean> {
  const { rows } = await db.query<{ topic_id: number }>(
    `update articles set state = 'discarded' where id = $1 and store_id = $2 and state in ('awaiting_review', 'ready') returning topic_id::int`,
    [articleId, storeId],
  )
  if (!rows[0]) return false
  const { rows: topics } = await db.query<{ canonical_key: string }>(`update topics set state = 'vetoed' where id = $1 returning canonical_key`, [rows[0].topic_id])
  await db.query(`insert into not_interested (store_id, canonical_key) values ($1, $2) on conflict do nothing`, [storeId, topics[0]!.canonical_key])
  return true
}

export type ExportBundle = { filename: string; bytes: Uint8Array }

/**
 * The export (§3.6): the Markdown, the rendered HTML and a metadata file, as one zip. The first
 * download of a ready article marks it exported; it can be downloaded again any time.
 */
export async function exportBundle(db: Db, storeId: number, articleId: number): Promise<ExportBundle | null> {
  const { rows } = await db.query<{
    title: string
    meta_description: string
    slug: string
    markdown: string
    html: string
    language: string
    state: ArticleStatus
    target_query: string
    products: { title: string; url: string | null; images: { url: string; width: number | null; height: number | null }[] }[]
  }>(
    `select a.title, a.meta_description, a.slug, a.markdown, a.html, a.language, a.state, t.target_query,
            coalesce((select json_agg(json_build_object('title', p.title, 'url', p.online_store_url, 'images', p.images) order by array_position(a.product_ids, p.id))
                      from products p where p.id = any(a.product_ids)), '[]') as products
     from articles a join topics t on t.id = a.topic_id join stores s on s.id = a.store_id
     where a.id = $1 and a.store_id = $2 and s.delivery_mode = 'export' and a.state in ('ready', 'exported')`,
    [articleId, storeId],
  )
  const a = rows[0]
  if (!a) return null
  const imageUrls = [...a.html.matchAll(/<img src="([^"]+)"/g)].map((m) => m[1]!.replace(/&amp;/g, '&'))
  const metadata = {
    title_tag: a.title,
    meta_description: a.meta_description,
    slug: a.slug,
    target_query: a.target_query,
    language: a.language,
    products: a.products.map((p) => ({ title: p.title, url: p.url })),
    image_urls: imageUrls,
    note: 'Prices are not in the text on purpose; the product links show the current price.',
  }
  const bytes = zip([
    { name: `${a.slug}.md`, content: `# ${a.title}\n\n${a.markdown}` },
    { name: `${a.slug}.html`, content: a.html },
    { name: `${a.slug}.json`, content: JSON.stringify(metadata, null, 2) + '\n' },
  ])
  if (a.state === 'ready') await db.query(`update articles set state = 'exported', delivered_at = now() where id = $1`, [articleId])
  return { filename: `${a.slug}.zip`, bytes }
}

/** "Where did you publish it?": accepted only on the store's own domain, so Search Console rows can be matched to it. */
export async function setPublishedUrl(db: Db, storeId: number, articleId: number, raw: string): Promise<'ok' | 'invalid' | 'not_found'> {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return 'invalid'
  }
  const { rows } = await db.query<{ hosts: string[] }>(`select array_remove(array[storefront_host, shop_domain], null) as hosts from stores where id = $1`, [storeId])
  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'invalid'
  if (!rows[0]?.hosts.some((h) => h.toLowerCase().replace(/^www\./, '') === host)) return 'invalid'
  const { rowCount } = await db.query(
    `update articles set published_url = $3 where id = $1 and store_id = $2 and state = 'exported'`,
    [articleId, storeId, `${url.origin}${url.pathname}`],
  )
  return rowCount ? 'ok' : 'not_found'
}
