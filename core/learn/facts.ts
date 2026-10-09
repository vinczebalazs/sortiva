import { z } from 'zod'
import type { Db } from '../../db/pool.ts'
import type { Language } from '../config.ts'
import type { Llm } from '../llm.ts'
import { htmlToText, normaliseForMatch } from './text.ts'

export const SOURCE_FIELDS = ['title', 'product_type', 'vendor', 'options', 'tags', 'metafields', 'description'] as const
export type SourceField = (typeof SOURCE_FIELDS)[number]

export type ProductForFacts = {
  id: number
  title: string
  product_type: string
  vendor: string
  options: { name: string; values: string[] }[]
  tags: string[]
  metafields: { namespace: string; key: string; value: string }[]
  description_html: string
}

/** The exact text of one field as the model was shown it; quotes are checked against this. */
export function sourceText(field: SourceField, p: ProductForFacts): string {
  switch (field) {
    case 'title':
      return p.title
    case 'product_type':
      return p.product_type
    case 'vendor':
      return p.vendor
    case 'options':
      return p.options.map((o) => `${o.name}: ${o.values.join(', ')}`).join('\n')
    case 'tags':
      return p.tags.join(', ')
    case 'metafields':
      return p.metafields.map((m) => `${m.key.replace(/_/g, ' ')}: ${m.value}`).join('\n')
    case 'description':
      return htmlToText(p.description_html)
  }
}

export const FACTS_PROMPT = {
  name: 'extract-facts',
  version: '1',
  system: {
    en: `You read one product from an online shop and list the facts it states about itself.

A fact is a short statement a customer could check against the product or its packaging: what it is made of, its size, weight, capacity, how many come in a pack, what it fits or works with, how to use or care for it, where or how it was made, which variants exist.

These are not facts: praise, feelings, promises, popularity, comparisons with unnamed rivals, claims about what the buyer deserves or will feel ("loved by thousands", "the best", "perfect for", "elevate your mornings"). Leave them out, even when they share a sentence with a fact. Never state a price.

For each fact give:
- fact: one sentence that names the product and says one thing about it, in the language of the product text. Add nothing the source does not say. Keep numbers and units exactly as written; do not convert or round.
- source_field: the field it came from.
- quote: the words in that field that support the fact, copied character for character as one continuous piece of the field. Every number in the fact must appear in the quote.

If the product states nothing checkable, return an empty list. A short true list is better than a long padded one.`,
    hu: `Egy webáruház egyetlen termékét olvasod el, és felsorolod azokat a tényeket, amelyeket a termék önmagáról állít.

Tény az a rövid állítás, amelyet a vásárló a terméken vagy a csomagoláson ellenőrizni tud: miből készült, mekkora, mennyi a tömege vagy az űrtartalma, hány darab van egy csomagban, mihez illik vagy mivel használható, hogyan kell használni vagy ápolni, hol vagy hogyan készült, milyen változatai vannak.

Nem tény a dicséret, az érzés, az ígéret, a népszerűség, a meg nem nevezett versenytársakhoz mért összehasonlítás, és az, hogy a vásárló mit érdemel vagy mit fog érezni („mindenki imádja”, „a legjobb”, „tökéletes választás”, „varázsold otthonodat…”). Ezeket hagyd ki akkor is, ha egy mondatban állnak egy ténnyel. Árat soha ne írj.

Minden tényhez add meg:
- fact: egyetlen mondat, amely megnevezi a terméket és egy dolgot állít róla, a termékszöveg nyelvén. Ne tegyél hozzá semmit, amit a forrás nem mond. A számokat és mértékegységeket pontosan úgy írd, ahogy a forrásban állnak; ne váltsd át és ne kerekítsd őket.
- source_field: a mező, ahonnan származik.
- quote: a mezőnek az a része, amely alátámasztja a tényt, betűről betűre kimásolva, egyetlen összefüggő darabként. A tényben szereplő minden számnak szerepelnie kell az idézetben.

Ha a termék semmi ellenőrizhetőt nem állít, adj vissza üres listát. Egy rövid, igaz lista jobb egy hosszú, felduzzasztottnál.`,
  } satisfies Record<Language, string>,
}

const FIELD_LABELS: Record<SourceField, string> = {
  title: 'title',
  product_type: 'product_type',
  vendor: 'vendor',
  options: 'options',
  tags: 'tags',
  metafields: 'metafields',
  description: 'description',
}

export function factsUserMessage(p: ProductForFacts): string {
  return SOURCE_FIELDS.map((field) => {
    const text = sourceText(field, p)
    return `<${FIELD_LABELS[field]}>\n${text}\n</${FIELD_LABELS[field]}>`
  }).join('\n\n')
}

export const factsSchema = z.object({
  facts: z.array(
    z.object({
      fact: z.string(),
      source_field: z.enum(SOURCE_FIELDS),
      quote: z.string(),
    }),
  ),
})

export type CheckedFact = { fact: string; source_field: SourceField; quote: string }

/** The mechanical half of rule 2 at the source: a fact survives only if its quote and its numbers are really there. */
export function checkFact(fact: CheckedFact, product: ProductForFacts): { ok: true } | { ok: false; reason: string } {
  const quote = fact.quote.trim()
  if (!quote) return { ok: false, reason: 'empty quote' }
  if (!normaliseForMatch(sourceText(fact.source_field, product)).includes(normaliseForMatch(quote))) {
    return { ok: false, reason: `quote not found in ${fact.source_field}` }
  }
  const quoteNumbers = new Set(quote.match(/\d+/g) ?? [])
  // A fact names its product, and a number in the name ("Ridgeline 2") is not a claim the quote must carry.
  const claim = normaliseForMatch(fact.fact).split(normaliseForMatch(product.title)).join(' ')
  const missing = (claim.match(/\d+/g) ?? []).filter((n) => !quoteNumbers.has(n))
  if (missing.length) return { ok: false, reason: `numbers not in the quote: ${missing.join(', ')}` }
  return { ok: true }
}

export type FactsOutcome = { kept: number; dropped: { fact: string; reason: string }[] }

/** One model call and the mechanical check; nothing stored. The eval runs exactly this. */
export async function distil(llm: Llm, storeId: number | null, language: Language, product: ProductForFacts): Promise<{ kept: CheckedFact[]; dropped: FactsOutcome['dropped'] }> {
  const answer = await llm.json({
    storeId,
    prompt: { name: FACTS_PROMPT.name, version: FACTS_PROMPT.version },
    system: FACTS_PROMPT.system[language],
    user: factsUserMessage(product),
    schema: factsSchema,
    effort: 'medium',
    maxTokens: 12_000,
  })
  const kept: CheckedFact[] = []
  const dropped: FactsOutcome['dropped'] = []
  const seen = new Set<string>()
  for (const fact of answer.facts) {
    const check = checkFact(fact, product)
    if (!check.ok) dropped.push({ fact: fact.fact, reason: check.reason })
    else if (!seen.has(normaliseForMatch(fact.fact))) {
      seen.add(normaliseForMatch(fact.fact))
      kept.push(fact)
    }
  }
  return { kept, dropped }
}

/** Distils one product into a fact sheet and stores it, replacing the old one. */
export async function extractFacts(db: Db, llm: Llm, storeId: number, language: Language, product: ProductForFacts & { content_hash: string }): Promise<FactsOutcome> {
  const { kept, dropped } = await distil(llm, storeId, language, product)

  const client = await db.connect()
  try {
    await client.query('begin')
    await client.query('delete from product_facts where product_id = $1', [product.id])
    for (const fact of kept) {
      await client.query(
        'insert into product_facts (store_id, product_id, fact, source_field, source_excerpt) values ($1, $2, $3, $4, $5)',
        [storeId, product.id, fact.fact.trim(), fact.source_field, fact.quote.trim()],
      )
    }
    await client.query('update products set facts_hash = $2, richness = $3 where id = $1', [product.id, product.content_hash, kept.length])
    await client.query('commit')
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
  return { kept: kept.length, dropped }
}
