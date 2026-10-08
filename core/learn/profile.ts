import { z } from 'zod'
import type { Db } from '../../db/pool.ts'
import type { Language } from '../config.ts'
import type { Llm } from '../llm.ts'

export function languageFromLocale(locale: string | null): Language | null {
  if (!locale) return null
  const base = locale.toLowerCase().split(/[-_]/)[0]
  return base === 'hu' || base === 'en' ? base : null
}

export const PROFILE_PROMPT = {
  name: 'draft-profile',
  version: '1',
  system: {
    en: `You are shown the catalogue of an online shop: its name, country and products, with the checked facts we hold about each product. Draft a short store profile that the shop owner will read and correct.

- sells: two or three plain sentences on what the shop sells, by kind of product, as the catalogue shows it.
- audience: one or two sentences on who buys it, only as far as the products themselves show. Do not invent ages, incomes or lifestyles.
- tone: the voice that suits this catalogue for articles: "plain", "friendly" or "expert".

Use only what the catalogue shows. Write in English.`,
    hu: `Egy webáruház katalógusát látod: a nevét, az országát és a termékeit, mindegyik mellett az általunk ellenőrzött tényekkel. Írj rövid boltprofilt, amelyet a bolt tulajdonosa elolvas és kijavít.

- sells: két-három egyszerű mondat arról, mit árul a bolt, termékfajták szerint, ahogy a katalógusból látszik.
- audience: egy-két mondat arról, kik vásárolnak itt, csak annyit, amennyit maguk a termékek mutatnak. Ne találj ki életkort, jövedelmet vagy életstílust.
- tone: a cikkekhez illő hangnem: "plain" (egyszerű), "friendly" (barátságos) vagy "expert" (szakértői).

Csak arra támaszkodj, amit a katalógus mutat. Magyarul írj.`,
  } satisfies Record<Language, string>,
}

export const profileSchema = z.object({
  sells: z.string(),
  audience: z.string(),
  tone: z.enum(['plain', 'friendly', 'expert']),
})

const MAX_PRODUCTS_SHOWN = 60
const FACTS_PER_PRODUCT = 4

export async function draftProfile(db: Db, llm: Llm, storeId: number, language: Language): Promise<void> {
  const store = await db.query<{ name: string; country: string | null }>(
    `select coalesce(name, shop_domain) as name, country from stores where id = $1`,
    [storeId],
  )
  const { rows: products } = await db.query<{ title: string; product_type: string; collections: { title: string }[]; facts: string[] }>(
    `select p.title, p.product_type, p.collections,
            coalesce((select array_agg(f.fact order by f.id) from (select * from product_facts where product_id = p.id order by id limit ${FACTS_PER_PRODUCT}) f), '{}') as facts
     from products p where p.store_id = $1 and p.deleted_at is null order by p.id limit ${MAX_PRODUCTS_SHOWN}`,
    [storeId],
  )
  const lines = products.map((p) => {
    const collections = p.collections.map((c) => c.title).join(', ')
    const facts = p.facts.map((f) => `    - ${f}`).join('\n')
    return `- ${p.title}${p.product_type ? ` (${p.product_type})` : ''}${collections ? ` — ${collections}` : ''}${facts ? `\n${facts}` : ''}`
  })
  const country = store.rows[0]?.country ?? ''
  const user = `<shop>${store.rows[0]?.name ?? ''}</shop>\n<country>${country}</country>\n<products>\n${lines.join('\n')}\n</products>`
  const draft = await llm.json({
    storeId,
    prompt: { name: PROFILE_PROMPT.name, version: PROFILE_PROMPT.version },
    system: PROFILE_PROMPT.system[language],
    user,
    schema: profileSchema,
    effort: 'medium',
    maxTokens: 8_000,
  })
  await db.query(
    `insert into store_profile (store_id, sells, audience, language, country, tone)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (store_id) do update set sells = excluded.sells, audience = excluded.audience, tone = excluded.tone, drafted_at = now()
     where store_profile.confirmed_at is null`,
    [storeId, draft.sells, draft.audience, language, country, draft.tone],
  )
}
