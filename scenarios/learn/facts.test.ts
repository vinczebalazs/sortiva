import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CONFIG } from '../../core/config.ts'
import { sourceText } from '../../core/learn/facts.ts'
import { normaliseForMatch } from '../../core/learn/text.ts'
import { startPipeline, type Pipeline } from '../pipeline.ts'

let p: Pipeline
beforeAll(async () => {
  p = await startPipeline()
})
afterAll(() => p?.stop())

async function factsOf(storeId: number) {
  const { rows } = await p.db.pool.query(
    `select p.id, p.title, p.richness, p.product_type, p.vendor, p.options, p.tags, p.metafields, p.description_html,
            coalesce(json_agg(json_build_object('fact', f.fact, 'field', f.source_field, 'excerpt', f.source_excerpt)) filter (where f.id is not null), '[]') as facts
     from products p left join product_facts f on f.product_id = p.id
     where p.store_id = $1 and p.deleted_at is null group by p.id order by p.id`,
    [storeId],
  )
  return rows
}

const normalise = normaliseForMatch

describe.each(['rich-en', 'rich-hu'])('%s: every fact cites the field it came from', (name) => {
  it('quotes its source verbatim, and every number in it appears in that quote', async () => {
    const store = await p.install(name)
    await p.settle()
    const products = await factsOf(store.id)
    expect(products.length).toBe(12)
    for (const product of products) {
      expect(product.facts.length, product.title).toBeGreaterThanOrEqual(CONFIG.minFactsPerProduct)
      expect(product.richness).toBe(product.facts.length)
      for (const fact of product.facts) {
        const source = sourceText(fact.field, product)
        expect(normalise(source), `${product.title}: ${fact.fact}`).toContain(normalise(fact.excerpt))
        for (const n of fact.fact.match(/\d+/g) ?? []) expect(fact.excerpt.replace(/\D/g, ' '), fact.fact).toMatch(new RegExp(`\\b${n}\\b`))
      }
    }
  })
})

describe.each(['fluff-en', 'fluff-hu'])('%s: marketing copy yields nothing to say', (name) => {
  it('gives pure marketing products fewer facts than the floor, and puts the store in the thin state', async () => {
    const store = await p.install(name)
    await p.settle()
    const products = await factsOf(store.id)
    const adequate = products.filter((x) => x.richness >= CONFIG.minFactsPerProduct)
    expect(adequate.map((x) => x.title)).toEqual([products.find((x) => /len|linen/i.test(x.title))!.title])
    const state = await p.thinState(store.id)
    expect(state).toEqual({ thin: true, usable: 1, total: 5 })
  })
})

describe.each(['empty-en', 'empty-hu'])('%s', (name) => {
  it('stops setup at "add products first" and spends nothing', async () => {
    const store = await p.install(name)
    await p.settle()
    const { rows } = await p.db.pool.query('select setup_step from stores where id = $1', [store.id])
    expect(rows[0].setup_step).toBe('no_products')
    const calls = await p.db.pool.query('select count(*)::int as n from llm_calls where store_id = $1', [store.id])
    expect(calls.rows[0].n).toBe(0)
  })
})
