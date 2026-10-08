import type { Db } from '../../db/pool.ts'
import { CONFIG, type Language } from '../config.ts'
import type { Evidence } from '../topics/evidence.ts'

export type PackFact = { ref: string; id: number; productRef: string; text: string }
export type PackImage = { url: string; width: number | null; height: number | null; altText: string | null }
export type PackProduct = { ref: string; id: number; platformId: string; title: string; productType: string; url: string | null; images: PackImage[]; core: boolean }
export type PackLink = { ref: string; kind: 'product' | 'article' | 'page' | 'collection'; title: string; url: string }

/**
 * Everything the writer and the judge may see (rule 1): the topic, the store's profile, fact sheets
 * and linkable pages. No product description, price or other raw catalogue text is in here.
 */
export type EvidencePack = {
  storeId: number
  topicId: number
  language: Language
  storeName: string
  /** Hosts our links may point at: the storefront's own domain and the myshopify one. */
  hosts: string[]
  topic: { workingTitle: string; targetQuery: string; searches: number | null; source: 'discovery' | 'manual' | 'refresh' }
  profile: { sells: string; audience: string; tone: string; neverSay: string }
  products: PackProduct[]
  facts: PackFact[]
  links: PackLink[]
}

type ProductRow = { id: number; platform_id: string; title: string; product_type: string; online_store_url: string | null; images: PackImage[]; core: boolean }

export async function loadPack(db: Db, storeId: number, topicId: number): Promise<EvidencePack> {
  const { rows: topics } = await db.query<{
    working_title: string
    target_query: string
    language: Language
    product_ids: number[]
    evidence: Evidence | Record<string, never>
    source: EvidencePack['topic']['source']
  }>(`select working_title, target_query, language, product_ids::int[], evidence, source from topics where id = $1 and store_id = $2`, [topicId, storeId])
  const topic = topics[0]
  if (!topic) throw new Error(`topic ${topicId} is not in store ${storeId}`)
  const { rows: stores } = await db.query<{ name: string | null; shop_domain: string; storefront_host: string | null }>(
    `select name, shop_domain, storefront_host from stores where id = $1`,
    [storeId],
  )
  const store = stores[0]!
  const { rows: profiles } = await db.query<EvidencePack['profile']>(
    `select sells, audience, tone, never_say as "neverSay" from store_profile where store_id = $1`,
    [storeId],
  )

  // The topic's own products first, then usable ones of the same kinds, so comparisons and gift guides have room.
  const { rows: products } = await db.query<ProductRow>(
    `with core as (select unnest($2::bigint[]) as id)
     select p.id::int, p.platform_id, p.title, p.product_type, p.online_store_url, p.images, p.id in (select id from core) as core
     from products p
     where p.store_id = $1 and p.deleted_at is null and p.richness >= $3
       and (p.id in (select id from core)
            or p.product_type in (select product_type from products where id in (select id from core) and product_type <> ''))
     order by (p.id in (select id from core)) desc, array_position($2::bigint[], p.id), p.richness desc, p.id
     limit $4`,
    [storeId, topic.product_ids, CONFIG.minFactsPerProduct, Math.max(CONFIG.write.maxProducts, topic.product_ids.length)],
  )
  const packProducts: PackProduct[] = products.map((p, i) => ({
    ref: `P${i + 1}`,
    id: p.id,
    platformId: p.platform_id,
    title: p.title,
    productType: p.product_type,
    url: p.online_store_url,
    images: p.images,
    core: p.core,
  }))
  const refOf = new Map(packProducts.map((p) => [p.id, p.ref]))
  const { rows: facts } = await db.query<{ id: number; product_id: number; fact: string }>(
    `select id::int, product_id::int, fact from product_facts where product_id = any($1::bigint[]) order by product_id, id`,
    [packProducts.map((p) => p.id)],
  )
  const packFacts = facts
    .sort((a, b) => packProducts.findIndex((p) => p.id === a.product_id) - packProducts.findIndex((p) => p.id === b.product_id) || a.id - b.id)
    .map((f, i) => ({ ref: `F${i + 1}`, id: f.id, productRef: refOf.get(f.product_id)!, text: f.fact }))

  const { rows: pages } = await db.query<{ kind: 'article' | 'page' | 'collection'; title: string; url: string }>(
    `select kind, title, url from store_pages where store_id = $1 and kind in ('article', 'collection', 'page') order by kind = 'collection' desc, kind = 'article' desc, id limit $2`,
    [storeId, CONFIG.write.maxLinkPages],
  )
  const links: PackLink[] = [
    ...packProducts.filter((p) => p.url).map((p) => ({ kind: 'product' as const, title: p.title, url: p.url!, ref: p.ref })),
    ...pages.map((p, i) => ({ kind: p.kind, title: p.title, url: p.url, ref: `L${i + 1}` })),
  ]

  return {
    storeId,
    topicId,
    language: topic.language,
    storeName: store.name ?? store.shop_domain,
    hosts: [store.storefront_host, store.shop_domain].filter((h): h is string => !!h).map((h) => h.toLowerCase()),
    topic: {
      workingTitle: topic.working_title,
      targetQuery: topic.target_query,
      searches: 'searches' in topic.evidence ? (topic.evidence.searches?.value ?? null) : null,
      source: topic.source,
    },
    profile: profiles[0] ?? { sells: '', audience: '', tone: 'plain', neverSay: '' },
    products: packProducts,
    facts: packFacts,
    links,
  }
}

/** The pack as the writer and the judge read it. */
export function packText(pack: EvidencePack): string {
  const products = pack.products
    .map((p) => {
      const facts = pack.facts.filter((f) => f.productRef === p.ref).map((f) => `    ${f.ref}: ${f.text}`)
      return `  ${p.ref}: ${p.title}${p.productType ? ` (${p.productType})` : ''}${p.core ? '' : ' [related]'}\n${facts.join('\n')}`
    })
    .join('\n')
  const pages = pack.links.filter((l) => l.kind !== 'product').map((l) => `  ${l.ref}: ${l.title} (${l.kind})`)
  return [
    `<store>\nName: ${pack.storeName}\nSells: ${pack.profile.sells}\nAudience: ${pack.profile.audience}\nTone: ${pack.profile.tone}\nNever say: ${pack.profile.neverSay || '—'}\n</store>`,
    `<topic>\nWorking title: ${pack.topic.workingTitle}\nSearch it targets: ${pack.topic.targetQuery}\n</topic>`,
    `<products>\n${products}\n</products>`,
    `<pages>\n${pages.length ? pages.join('\n') : '  —'}\n</pages>`,
  ].join('\n\n')
}
