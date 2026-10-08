import type { Db } from '../../db/pool.ts'
import { CONFIG, type Language } from '../config.ts'
import type { Demand, Market, TopResults } from '../demand.ts'
import type { Llm } from '../llm.ts'
import { canonicalKey } from './canonical.ts'
import { proposeCandidates, type Candidate, type ProfileForTopics, type ProductForTopics } from './candidates.ts'
import { coveringPage, onlyProductListings, rankScore, sameIntent, storeWideWords, top3, type StorePage } from './check.ts'
import type { Evidence } from './evidence.ts'

export type TopicDeps = { db: Db; llm: Llm; demand: Demand }

export type DropReason = 'already_ours' | 'not_interested' | 'existing_page' | 'below_demand_floor' | 'only_product_listings' | 'same_intent' | 'over_cap'

export type DiscoveryOutcome =
  | { ran: false; why: 'profile_not_confirmed' | 'queue_full' | 'no_usable_products' }
  | { ran: true; proposed: number; queued: { query: string; searches: number }[]; dropped: { query: string; reason: DropReason; detail?: string; searches?: number }[] }

export type StoreTopicContext = {
  profile: ProfileForTopics
  market: Market
  usable: ProductForTopics[]
  pages: StorePage[]
  thin: boolean
  storeWords: Set<string>
}

export async function topicContext(db: Db, storeId: number): Promise<StoreTopicContext | null> {
  const { rows: profiles } = await db.query<ProfileForTopics & { confirmed: boolean }>(
    `select sells, audience, language, country, tone, never_say, confirmed_at is not null as confirmed from store_profile where store_id = $1`,
    [storeId],
  )
  const profile = profiles[0]
  if (!profile?.confirmed) return null
  const { rows: usable } = await db.query<ProductForTopics>(
    `select p.id::int, p.title, p.product_type,
            coalesce((select array_agg(c->>'title') from jsonb_array_elements(p.collections) c), '{}') as collections,
            (select array_agg(f.fact order by f.id) from product_facts f where f.product_id = p.id) as facts
     from products p
     where p.store_id = $1 and p.deleted_at is null and p.richness >= $2
     order by p.product_type, p.id`,
    [storeId, CONFIG.minFactsPerProduct],
  )
  const { rows: pages } = await db.query<StorePage>(`select kind, title, handle, url from store_pages where store_id = $1`, [storeId])
  const { rows: titles } = await db.query<{ title: string }>(
    `select title from products where store_id = $1 and deleted_at is null
     union all select title from store_pages where store_id = $1 and kind in ('article', 'page')
     union all select coalesce(name, '') from stores where id = $1`,
    [storeId],
  )
  return {
    profile,
    market: { country: profile.country, language: profile.language },
    usable,
    pages,
    thin: usable.length < CONFIG.thinStoreFloor,
    storeWords: storeWideWords(titles.map((t) => t.title), profile.language),
  }
}

/** How many topics may wait in this store's queue. */
export function queueCap(ctx: StoreTopicContext): number {
  return ctx.thin ? ctx.usable.length : CONFIG.topics.queueCap
}

type Existing = { canonical_key: string; target_query: string; state: string; top3: string[] | null }

async function existingTopics(db: Db, storeId: number): Promise<Existing[]> {
  const { rows } = await db.query<Existing>(
    `select canonical_key, target_query, state,
            (select array_agg(x) from jsonb_array_elements_text(evidence->'topResults'->'top3') x) as top3
     from topics where store_id = $1`,
    [storeId],
  )
  return rows
}

export function evidenceFor(market: Market, searches: { value: number | null; source: string; date: string }, distinctFacts: number, top: TopResults | null): Evidence {
  return {
    searches: { ...searches, country: market.country, language: market.language },
    facts: { value: distinctFacts, source: 'catalogue', date: new Date().toISOString() },
    topResults: top
      ? { top3: top3(top.pages), productListings: top.pages.filter((p) => p.productListing).length, of: top.pages.length, source: top.source, date: top.fetchedAt }
      : null,
  }
}

export function distinctFacts(productIds: number[], products: ProductForTopics[]): number {
  return new Set(products.filter((p) => productIds.includes(p.id)).flatMap((p) => p.facts)).size
}

/**
 * Proposes topics from the confirmed profile and the products with enough facts, then lets
 * through only those that pass the existing-content check, clear the demand floor and can rank.
 */
export async function discoverTopics(deps: TopicDeps, storeId: number): Promise<DiscoveryOutcome> {
  const ctx = await topicContext(deps.db, storeId)
  if (!ctx) return { ran: false, why: 'profile_not_confirmed' }
  if (!ctx.usable.length) {
    await markDiscovered(deps.db, storeId)
    return { ran: false, why: 'no_usable_products' }
  }
  const existing = await existingTopics(deps.db, storeId)
  const waiting = existing.filter((t) => t.state === 'queued').length
  const slots = queueCap(ctx) - waiting
  if (slots <= 0) {
    await markDiscovered(deps.db, storeId)
    return { ran: false, why: 'queue_full' }
  }

  const { rows: vetoed } = await deps.db.query<{ canonical_key: string }>('select canonical_key from not_interested where store_id = $1', [storeId])
  const covered = [...existing.map((t) => t.target_query), ...ctx.pages.filter((p) => p.kind === 'article' || p.kind === 'page').map((p) => p.title)]
  const language: Language = ctx.profile.language
  const proposed = await proposeCandidates(deps.llm, storeId, ctx.profile, ctx.usable, covered, Math.min(CONFIG.topics.maxCandidates, slots * 2))

  const dropped: Extract<DiscoveryOutcome, { ran: true }>['dropped'] = []
  // A topic the merchant skipped (state 'candidate') may be proposed again; every other state is ours already.
  const ourKeys = new Set(existing.filter((t) => t.state !== 'candidate').map((t) => t.canonical_key))
  const vetoedKeys = new Set(vetoed.map((v) => v.canonical_key))
  const seen = new Set<string>()
  const lexical: (Candidate & { key: string })[] = []
  for (const c of proposed) {
    const key = canonicalKey(c.targetQuery, language)
    if (!key || seen.has(key) || ourKeys.has(key)) {
      dropped.push({ query: c.targetQuery, reason: 'already_ours' })
      continue
    }
    seen.add(key)
    if (vetoedKeys.has(key)) {
      dropped.push({ query: c.targetQuery, reason: 'not_interested' })
      continue
    }
    const page = coveringPage(c.targetQuery, language, ctx.pages, ctx.storeWords)
    if (page) {
      dropped.push({ query: c.targetQuery, reason: 'existing_page', detail: page.title })
      continue
    }
    lexical.push({ ...c, key })
  }

  const volumes = await deps.demand.searchVolumes({ storeId, market: ctx.market, keywords: lexical.map((c) => c.targetQuery) })
  const volumeOf = new Map(volumes.map((v) => [v.keyword, v]))
  const floor = CONFIG.demandFloor[language]
  const withDemand = lexical
    .map((c) => ({ ...c, volume: volumeOf.get(c.targetQuery)! }))
    .filter((c) => {
      const ok = (c.volume?.searches ?? 0) >= floor
      if (!ok) dropped.push({ query: c.targetQuery, reason: 'below_demand_floor', detail: String(c.volume?.searches ?? 'none') })
      return ok
    })
    .sort((a, b) => b.volume.searches! - a.volume.searches!)

  const taken: { top3: string[] }[] = existing.filter((t) => (t.state === 'queued' || t.state === 'scheduled') && t.top3).map((t) => ({ top3: t.top3! }))
  const survivors: { candidate: (typeof withDemand)[number]; top: TopResults; score: number }[] = []
  const tops = await deps.demand.topResults({ storeId, market: ctx.market, keywords: withDemand.map((c) => c.targetQuery) })
  for (const [i, c] of withDemand.entries()) {
    const top = tops[i]!
    if (onlyProductListings(top.pages)) {
      dropped.push({ query: c.targetQuery, reason: 'only_product_listings' })
      continue
    }
    // Highest demand first, so of two same-intent candidates the one already taken is the higher-demand one.
    const mine = top3(top.pages)
    const clash = [...taken, ...survivors.map((s) => ({ top3: top3(s.top.pages), query: s.candidate.targetQuery }))].find((t) => sameIntent(mine, t.top3))
    if (clash) {
      dropped.push({ query: c.targetQuery, reason: 'same_intent', detail: 'query' in clash ? (clash as { query: string }).query : undefined, searches: c.volume.searches! })
      continue
    }
    survivors.push({ candidate: c, top, score: rankScore({ searches: c.volume.searches!, distinctFacts: distinctFacts(c.productIds, ctx.usable), pages: top.pages }) })
  }

  survivors.sort((a, b) => b.score - a.score)
  for (const s of survivors.slice(slots)) dropped.push({ query: s.candidate.targetQuery, reason: 'over_cap' })
  const keep = survivors.slice(0, slots)
  for (const { candidate: c, top, score } of keep) {
    const evidence = evidenceFor(ctx.market, { value: c.volume.searches, source: c.volume.source, date: c.volume.fetchedAt }, distinctFacts(c.productIds, ctx.usable), top)
    await deps.db.query(
      `insert into topics (store_id, canonical_key, source, working_title, target_query, language, product_ids, demand, evidence, rank, state)
       values ($1, $2, 'discovery', $3, $4, $5, $6, $7, $8, $9, 'queued')
       on conflict (store_id, canonical_key) do update set state = 'queued', language = excluded.language, working_title = excluded.working_title, target_query = excluded.target_query,
         product_ids = excluded.product_ids, demand = excluded.demand, evidence = excluded.evidence, rank = excluded.rank, manual_position = null
       where topics.state = 'candidate'`,
      [storeId, c.key, c.workingTitle, c.targetQuery, language, c.productIds, c.volume.searches, JSON.stringify(evidence), score],
    )
  }
  await markDiscovered(deps.db, storeId)
  return { ran: true, proposed: proposed.length, queued: keep.map((k) => ({ query: k.candidate.targetQuery, searches: k.candidate.volume.searches! })), dropped }
}

async function markDiscovered(db: Db, storeId: number): Promise<void> {
  await db.query('update stores set topics_discovered_at = now() where id = $1', [storeId])
}

/** Whether the queue has run low enough to look for more topics now. */
export async function shouldRediscover(db: Db, storeId: number): Promise<boolean> {
  const { rows } = await db.query<{ due: boolean }>(
    `select s.setup_step = 'done'
            and (select count(*) from topics t where t.store_id = s.id and t.state = 'queued') < $2
            and (s.topics_discovered_at is null or s.topics_discovered_at < now() - make_interval(days => $3)) as due
     from stores s where s.id = $1`,
    [storeId, CONFIG.topics.lowQueue, CONFIG.topics.rediscoverAfterDays],
  )
  return Boolean(rows[0]?.due)
}
