import { z } from 'zod'
import type { Language } from '../config.ts'
import type { Llm } from '../llm.ts'

export const CANDIDATES_PROMPT = {
  name: 'propose-topics',
  version: '2',
  system: {
    en: `You plan blog articles for an online shop. You see the shop's profile and its products, grouped by kind, each with the checked facts we hold about it. Propose articles that this shop can write credibly and that people actually search for.

Each article:
- answers a question a shopper has before or after buying this kind of product: how to choose, how to use, how to care for it, how two kinds the shop sells differ, what a feature means;
- is about a kind of product or a group of products, never about one single item for sale;
- can be written from the facts of the products it mentions, and mentions one to four of them by their reference (P1, P2…);
- targets one search: give two or three different phrasings a shopper might type into Google for this same article, the most common wording first. Each in English, two to six words, lower case, no brand names, no prices, no years. Prefer the short, everyday words people actually type over precise or technical ones; we keep whichever phrasing most people search.

Do not propose anything about prices, discounts, delivery, competitors or the shop itself. Do not propose topics listed as already covered, nor close rewordings of them. Respect the owner's "never say" list. Propose fewer articles rather than weak ones; return an empty list if nothing fits.

For each article give: working_title (a plain headline in English), target_queries (the phrasings), products (the references), group (the product kind it belongs to).`,
    hu: `Egy webáruház blogcikkeit tervezed. Látod a bolt profilját és a termékeit fajták szerint csoportosítva, mindegyik mellett az általunk ellenőrzött tényekkel. Javasolj olyan cikkeket, amelyeket ez a bolt hitelesen meg tud írni, és amelyekre az emberek valóban keresnek.

Minden cikk:
- olyan kérdésre válaszol, amely a vásárlóban az ilyen termék megvétele előtt vagy után felmerül: hogyan válasszon, hogyan használja, hogyan ápolja, miben különbözik a bolt két terméktípusa, mit jelent egy tulajdonság;
- egy termékfajtáról vagy termékcsoportról szól, soha nem egyetlen eladó tételről;
- megírható az általa említett termékek tényeiből, és egy-négy terméket említ a hivatkozásukkal (P1, P2…);
- egy keresést céloz: adj meg két-három különböző megfogalmazást, ahogyan a vásárló ugyanerre a cikkre rákeresne a Google-ben, a leggyakoribbal kezdve. Mindegyik magyarul, két-hat szóban, kisbetűvel, márkanév, ár és évszám nélkül. A rövid, hétköznapi szavakat részesítsd előnyben a pontos vagy szakmai kifejezésekkel szemben; azt a megfogalmazást tartjuk meg, amelyre a legtöbben keresnek.

Ne javasolj semmit árakról, kedvezményekről, szállításról, versenytársakról vagy magáról a boltról. Ne javasolj olyan témát, amely a már lefedettek között szerepel, és ezek közeli átfogalmazását sem. Tartsd tiszteletben a tulajdonos „soha ne írd” listáját. Inkább kevesebb cikket javasolj, mint gyengét; ha semmi sem illik, adj vissza üres listát.

Minden cikkhez add meg: working_title (egyszerű magyar cím), target_queries (a megfogalmazások), products (a hivatkozások), group (a termékfajta, amelyhez tartozik).`,
  } satisfies Record<Language, string>,
}

// The prompt asks for two or three; anything beyond is dropped rather than paid for.
const MAX_PHRASINGS = 3

export const candidatesSchema = z.object({
  topics: z.array(
    z.object({
      working_title: z.string(),
      target_queries: z.array(z.string()),
      products: z.array(z.string()),
      group: z.string(),
    }),
  ),
})

export type ProfileForTopics = { sells: string; audience: string; language: Language; country: string; tone: string; never_say: string }
export type ProductForTopics = { id: number; title: string; product_type: string; collections: string[]; facts: string[] }
/** One proposed article; `phrasings` are ways to search for it, the model's most common guess first. */
export type Candidate = { workingTitle: string; phrasings: string[]; productIds: number[]; group: string }

function groupOf(p: ProductForTopics): string {
  return p.product_type || p.collections[0] || '—'
}

export function candidatesUserMessage(profile: ProfileForTopics, products: ProductForTopics[], covered: string[], max: number): string {
  const groups = new Map<string, string[]>()
  products.forEach((p, i) => {
    const lines = [`  P${i + 1}: ${p.title}`, ...p.facts.map((f) => `    - ${f}`)]
    groups.set(groupOf(p), [...(groups.get(groupOf(p)) ?? []), lines.join('\n')])
  })
  const catalogue = [...groups].map(([group, items]) => `<group name="${group}">\n${items.join('\n')}\n</group>`).join('\n')
  return [
    `<profile>\nSells: ${profile.sells}\nAudience: ${profile.audience}\nCountry: ${profile.country}\nTone: ${profile.tone}\nNever say: ${profile.never_say || '—'}\n</profile>`,
    `<products>\n${catalogue}\n</products>`,
    `<already_covered>\n${covered.length ? covered.map((c) => `- ${c}`).join('\n') : '—'}\n</already_covered>`,
    `<at_most>${max}</at_most>`,
  ].join('\n\n')
}

/** One model call for the whole store. References the model invents are dropped, not trusted. */
export async function proposeCandidates(
  llm: Llm,
  storeId: number,
  profile: ProfileForTopics,
  products: ProductForTopics[],
  covered: string[],
  max: number,
): Promise<Candidate[]> {
  if (!products.length || max <= 0) return []
  const answer = await llm.json({
    storeId,
    prompt: { name: CANDIDATES_PROMPT.name, version: CANDIDATES_PROMPT.version },
    system: CANDIDATES_PROMPT.system[profile.language],
    user: candidatesUserMessage(profile, products, covered, max),
    schema: candidatesSchema,
    effort: 'medium',
    maxTokens: 12_000,
  })
  const out: Candidate[] = []
  for (const t of answer.topics.slice(0, max)) {
    const ids = [...new Set(t.products.map((ref) => products[Number(ref.replace(/\D/g, '')) - 1]?.id).filter((id): id is number => id !== undefined))]
    const phrasings = [...new Set(t.target_queries.map((q) => q.trim().toLowerCase()).filter(Boolean))].slice(0, MAX_PHRASINGS)
    if (!ids.length || !phrasings.length) continue
    out.push({ workingTitle: t.working_title.trim(), phrasings, productIds: ids, group: t.group })
  }
  return out
}
