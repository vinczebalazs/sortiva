import { z } from 'zod'
import { CONFIG, type Language } from '../config.ts'
import { canonicalKey } from './canonical.ts'
import { coveringPage } from './check.ts'
import { distinctFacts, evidenceFor, topicContext, type TopicDeps } from './discover.ts'
import { moveToTop } from './queue.ts'

export const MATCH_PROMPT = {
  name: 'match-topic',
  version: '1',
  system: {
    en: `A shop owner wants an article about the subject they typed. You see the subject and the shop's products. Work out:
- target_query: the phrase a shopper would type into Google to find such an article, in English, two to six words, lower case;
- working_title: a plain headline in English;
- products: the references (P1, P2…) of the products the article would be about or would mention. Only products that truly belong to the subject; an empty list if the shop sells nothing related.`,
    hu: `A bolt tulajdonosa cikket szeretne a beírt témáról. Látod a témát és a bolt termékeit. Határozd meg:
- target_query: a kifejezést, amelyet a vásárló a Google-be írna, hogy ilyen cikket találjon, magyarul, két-hat szóban, kisbetűvel;
- working_title: egyszerű magyar cím;
- products: azoknak a termékeknek a hivatkozása (P1, P2…), amelyekről a cikk szólna vagy amelyeket említene. Csak a témához valóban tartozó termékek; üres lista, ha a bolt semmi kapcsolódót nem árul.`,
  } satisfies Record<Language, string>,
}

const matchSchema = z.object({ target_query: z.string(), working_title: z.string(), products: z.array(z.string()) })

export type ManualOutcome =
  | { kind: 'added'; topicId: number }
  | { kind: 'moved'; topicId: number }
  | { kind: 'existing_page'; title: string; url: string }
  | { kind: 'cannot_back'; products: { id: number; title: string }[] }

/**
 * A topic the merchant asks for, through the same checks as ours. Their choice overrides the
 * demand floor; one already waiting in the queue moves to the top instead of being added twice.
 */
export async function addManualTopic(deps: TopicDeps, storeId: number, phrase: string): Promise<ManualOutcome | { kind: 'not_ready' }> {
  const ctx = await topicContext(deps.db, storeId)
  if (!ctx) return { kind: 'not_ready' }
  const language = ctx.profile.language

  const queuedMatch = async (key: string) => {
    const { rows } = await deps.db.query<{ id: number; state: string; title: string }>(
      `select id::int, state, working_title as title from topics where store_id = $1 and canonical_key = $2`,
      [storeId, key],
    )
    return rows[0]
  }
  const typed = await queuedMatch(canonicalKey(phrase, language))
  if (typed?.state === 'queued' && (await moveToTop(deps.db, storeId, typed.id))) return { kind: 'moved', topicId: typed.id }

  const typedPage = coveringPage(phrase, language, ctx.pages, ctx.storeWords)
  if (typedPage) return { kind: 'existing_page', title: typedPage.title, url: typedPage.url }

  const { rows: all } = await deps.db.query<{ id: number; title: string; product_type: string; richness: number | null }>(
    `select id::int, title, product_type, richness from products where store_id = $1 and deleted_at is null order by product_type, id`,
    [storeId],
  )
  const answer = await deps.llm.json({
    storeId,
    prompt: { name: MATCH_PROMPT.name, version: MATCH_PROMPT.version },
    system: MATCH_PROMPT.system[language],
    user: `<subject>${phrase.trim()}</subject>\n<products>\n${all.map((p, i) => `P${i + 1}: ${p.title}${p.product_type ? ` (${p.product_type})` : ''}`).join('\n')}\n</products>`,
    schema: matchSchema,
    effort: 'low',
    maxTokens: 4_000,
  })
  const related = [...new Set(answer.products.map((ref) => all[Number(ref.replace(/\D/g, '')) - 1]).filter((p) => p !== undefined))]
  const backed = related.filter((p) => (p.richness ?? 0) >= CONFIG.minFactsPerProduct).map((p) => p.id)
  if (!backed.length) return { kind: 'cannot_back', products: related.map((p) => ({ id: p.id, title: p.title })) }

  const targetQuery = answer.target_query.trim().toLowerCase() || phrase.trim().toLowerCase()
  const key = canonicalKey(targetQuery, language)
  const existing = await queuedMatch(key)
  if (existing?.state === 'queued' && (await moveToTop(deps.db, storeId, existing.id))) return { kind: 'moved', topicId: existing.id }
  if (existing && (existing.state === 'written' || existing.state === 'delivered')) {
    return { kind: 'existing_page', title: existing.title, url: '' }
  }
  const page = coveringPage(targetQuery, language, ctx.pages, ctx.storeWords)
  if (page) return { kind: 'existing_page', title: page.title, url: page.url }

  const [volume] = await deps.demand.searchVolumes({ storeId, market: ctx.market, keywords: [targetQuery] })
  const top = await deps.demand.topResults({ storeId, market: ctx.market, keyword: targetQuery })
  const evidence = evidenceFor(ctx.market, { value: volume?.searches ?? null, source: volume?.source ?? '', date: volume?.fetchedAt ?? new Date().toISOString() }, distinctFacts(backed, ctx.usable), top)

  // Asked for by name, so an earlier "not interested" no longer stands.
  await deps.db.query('delete from not_interested where store_id = $1 and canonical_key = $2', [storeId, key])
  const { rows } = await deps.db.query<{ id: number }>(
    `insert into topics (store_id, canonical_key, source, working_title, target_query, language, product_ids, demand, evidence, state, manual_position)
     values ($1, $2, 'manual', $3, $4, $5, $6, $7, $8, 'queued', coalesce((select min(manual_position) from topics where store_id = $1 and state = 'queued'), 1) - 1)
     on conflict (store_id, canonical_key) do update set state = 'queued', source = 'manual', working_title = excluded.working_title, target_query = excluded.target_query,
       product_ids = excluded.product_ids, demand = excluded.demand, evidence = excluded.evidence, manual_position = excluded.manual_position, held_reason = null
     returning id::int`,
    [storeId, key, answer.working_title.trim(), targetQuery, language, backed, volume?.searches ?? null, JSON.stringify(evidence)],
  )
  return { kind: 'added', topicId: rows[0]!.id }
}
