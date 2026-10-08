import { writeFileSync, mkdirSync } from 'node:fs'
import { CONFIG } from '../core/config.ts'
import { htmlToText } from '../core/learn/text.ts'
import { createPool } from '../db/pool.ts'

/**
 * Checkpoint 1's review page: for every fixture store in the local database (run
 * `pnpm seed:preview` with all fixtures first), five products beside their fact sheets.
 */
const PRODUCTS_PER_STORE = 5
const pool = createPool()

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

type Product = {
  id: number
  title: string
  product_type: string
  vendor: string
  options: { name: string; values: string[] }[]
  tags: string[]
  metafields: { key: string; value: string }[]
  description_html: string
  richness: number | null
  facts: { fact: string; field: string; quote: string }[]
}

const FIELD_NAMES: Record<string, string> = {
  title: 'Title',
  product_type: 'Product type',
  vendor: 'Vendor',
  options: 'Options',
  tags: 'Tags',
  metafields: 'Metafields',
  description: 'Description',
}

const stores = (
  await pool.query<{ id: number; name: string; shop_domain: string; primary_locale: string; setup_step: string; sells: string | null; audience: string | null; tone: string | null; total: number; usable: number }>(
    `select s.id, s.name, s.shop_domain, s.primary_locale, s.setup_step, p.sells, p.audience, p.tone,
            (select count(*)::int from products where store_id = s.id and deleted_at is null) as total,
            (select count(*)::int from products where store_id = s.id and deleted_at is null and richness >= $1) as usable
     from stores s left join store_profile p on p.store_id = s.id order by s.id`,
    [CONFIG.minFactsPerProduct],
  )
).rows

const sections: string[] = []
const index: string[] = []
let factCount = 0
for (const store of stores) {
  const products = (
    await pool.query<Product>(
      `select p.id, p.title, p.product_type, p.vendor, p.options, p.tags, p.metafields, p.description_html, p.richness,
              coalesce(json_agg(json_build_object('fact', f.fact, 'field', f.source_field, 'quote', f.source_excerpt) order by f.id) filter (where f.id is not null), '[]') as facts
       from products p left join product_facts f on f.product_id = p.id
       where p.store_id = $1 and p.deleted_at is null group by p.id order by p.id limit $2`,
      [store.id, PRODUCTS_PER_STORE],
    )
  ).rows
  const anchor = store.shop_domain.split('.')[0]!
  const thin = store.usable < CONFIG.thinStoreFloor
  const language = store.primary_locale === 'hu' ? 'Hungarian' : 'English'
  index.push(
    `<a class="idx" href="#${anchor}"><span class="idx-name">${esc(store.name)}</span><span class="idx-meta">${language} · ${store.usable} of ${store.total} usable</span></a>`,
  )

  const rows = products.map((p) => {
    factCount += p.facts.length
    const usable = (p.richness ?? 0) >= CONFIG.minFactsPerProduct
    const source = [
      p.product_type && `<div class="kv"><span>Type</span>${esc(p.product_type)}</div>`,
      p.vendor && `<div class="kv"><span>Vendor</span>${esc(p.vendor)}</div>`,
      p.options.length && !(p.options.length === 1 && p.options[0]!.values[0] === 'Default Title')
        ? `<div class="kv"><span>Options</span>${p.options.map((o) => `${esc(o.name)}: ${esc(o.values.join(', '))}`).join('<br>')}</div>`
        : '',
      p.tags.length && `<div class="kv"><span>Tags</span>${esc(p.tags.join(', '))}</div>`,
      p.metafields.length && `<div class="kv"><span>Metafields</span>${p.metafields.map((m) => `${esc(m.key)}: ${esc(m.value)}`).join('<br>')}</div>`,
    ]
      .filter(Boolean)
      .join('')
    const facts = p.facts.length
      ? `<ol class="facts">${p.facts
          .map((f) => `<li><p class="fact">${esc(f.fact)}</p><p class="quote"><span class="field">${FIELD_NAMES[f.field] ?? f.field}</span>“${esc(f.quote)}”</p></li>`)
          .join('')}</ol>`
      : `<p class="none">No checkable statements. We would not write about this product.</p>`
    return `
      <article class="product">
        <div class="side src">
          <p class="label">What the merchant wrote</p>
          <h3>${esc(p.title)}</h3>
          ${source}
          <div class="desc">${esc(htmlToText(p.description_html)).replace(/\n/g, '<br>')}</div>
        </div>
        <div class="side out">
          <div class="out-head">
            <p class="label">Fact sheet</p>
            <span class="pill ${usable ? 'ok' : 'thin'}">${usable ? `Can write about it · ${p.facts.length} facts` : `Needs a fuller description · ${p.facts.length} ${p.facts.length === 1 ? 'fact' : 'facts'}`}</span>
          </div>
          ${facts}
        </div>
      </article>`
  })

  const profile = store.sells
    ? `<div class="profile"><div><p class="label">Drafted profile · what they sell</p><p>${esc(store.sells)}</p></div><div><p class="label">Who buys it</p><p>${esc(store.audience ?? '')}</p></div><div><p class="label">Tone</p><p>${esc(store.tone ?? '')}</p></div></div>`
    : ''
  const state =
    store.total === 0
      ? `<p class="state">The store has no products. Setup stops at “Add products to your store first” and nothing is spent.</p>`
      : thin
        ? `<p class="state">Thin store: ${store.usable} of ${store.total} products have enough facts (the floor is ${CONFIG.thinStoreFloor}). Home will say “We can write about ${store.usable} of your ${store.total} products.”</p>`
        : ''
  sections.push(`
    <section class="store" id="${anchor}">
      <header class="store-head">
        <div>
          <p class="label">${language} · ${esc(store.shop_domain)}</p>
          <h2>${esc(store.name)}</h2>
        </div>
        <span class="count">${store.usable} of ${store.total} products usable${store.total > PRODUCTS_PER_STORE ? ` · first ${PRODUCTS_PER_STORE} shown` : ''}</span>
      </header>
      ${state}
      ${profile}
      ${rows.join('')}
    </section>`)
}

const html = `<title>Checkpoint 1 Fact Sheets</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Poppins:wght@500;600&family=Plus+Jakarta+Sans:wght@400;500;600&display=swap">
<style>
/* Layout: one column of stores; each product is a two-sided sheet, source left, facts right. Look: the app's own mockup tokens. */
:root {
  --ground: #e8e9f0; --card: #ffffff; --ink: #191b23; --ink2: #454a5c; --mut: #6f7488; --faint: #878da0;
  --line: #edeef3; --soft: #f5f6fa; --pri: #6470f3; --pri-s: #eeeffe; --grn: #12a150; --grn-s: #e7f7ee; --amb: #9a5d07; --amb-s: #fdf3e4;
  --sh: 0 1px 2px rgba(21,25,42,.04), 0 8px 24px -6px rgba(21,25,42,.08);
  --fh: 'Poppins', system-ui, sans-serif; --fb: 'Plus Jakarta Sans', system-ui, sans-serif;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --ground: #14151b; --card: #1d1f27; --ink: #ecedf3; --ink2: #c3c6d4; --mut: #9a9fb2; --faint: #7c8196;
  --line: #2a2d38; --soft: #252833; --pri: #8f97f7; --pri-s: #262a4a; --grn: #4cc983; --grn-s: #18311f; --amb: #f0b45a; --amb-s: #3a2e18;
  --sh: 0 1px 2px rgba(0,0,0,.3), 0 8px 24px -6px rgba(0,0,0,.4); color-scheme: dark } }
:root[data-theme="dark"] {
  --ground: #14151b; --card: #1d1f27; --ink: #ecedf3; --ink2: #c3c6d4; --mut: #9a9fb2; --faint: #7c8196;
  --line: #2a2d38; --soft: #252833; --pri: #8f97f7; --pri-s: #262a4a; --grn: #4cc983; --grn-s: #18311f; --amb: #f0b45a; --amb-s: #3a2e18;
  --sh: 0 1px 2px rgba(0,0,0,.3), 0 8px 24px -6px rgba(0,0,0,.4); color-scheme: dark }
body { background: var(--ground); color: var(--ink); font: 400 14px/1.6 var(--fb); }
.wrap { max-width: 1120px; margin: 0 auto; padding-inline: 20px; padding-block: 36px 80px; display: flex; flex-direction: column; gap: 28px; }
h1, h2, h3 { font-family: var(--fh); font-weight: 500; letter-spacing: -.015em; text-wrap: balance; margin: 0; }
h1 { font-size: 32px; line-height: 1.15; }
h2 { font-size: 22px; }
h3 { font-size: 16px; line-height: 1.3; }
p { margin: 0; }
a { color: var(--pri); text-decoration: none; }
.label { font: 600 11px/1 var(--fb); letter-spacing: .08em; text-transform: uppercase; color: var(--faint); }
.lede { max-width: 68ch; color: var(--ink2); font-size: 15px; margin-top: 10px; }
.ask { background: var(--card); border-radius: 18px; box-shadow: var(--sh); padding: 20px 22px; display: grid; gap: 10px; }
.ask ul { margin: 0; padding-left: 18px; color: var(--ink2); }
.ask li + li { margin-top: 4px; }
.index { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; }
.idx { background: var(--card); border-radius: 14px; box-shadow: var(--sh); padding: 12px 14px; display: flex; flex-direction: column; gap: 3px; color: var(--ink); }
.idx:hover { outline: 1.5px solid var(--pri); }
.idx-name { font: 500 14px/1.3 var(--fh); }
.idx-meta { font-size: 12px; color: var(--mut); font-variant-numeric: tabular-nums; }
.store { display: flex; flex-direction: column; gap: 14px; scroll-margin-top: 16px; }
.store-head { display: flex; align-items: flex-end; gap: 12px; flex-wrap: wrap; padding-top: 18px; border-top: 1px solid var(--line); }
.store-head > div { display: grid; gap: 8px; }
.count { margin-left: auto; font: 600 12px/1 var(--fb); color: var(--ink2); background: var(--card); border-radius: 999px; padding: 8px 12px; box-shadow: var(--sh); font-variant-numeric: tabular-nums; }
.state { background: var(--amb-s); color: var(--amb); border-radius: 12px; padding: 11px 14px; font-weight: 500; font-size: 13px; }
.profile { background: var(--card); border-radius: 18px; box-shadow: var(--sh); padding: 18px 20px; display: grid; grid-template-columns: 2fr 1.4fr .6fr; gap: 18px; }
.profile > div { display: grid; gap: 7px; align-content: start; min-width: 0; }
.profile p:not(.label) { color: var(--ink2); font-size: 13.5px; }
.product { background: var(--card); border-radius: 18px; box-shadow: var(--sh); display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr); overflow: hidden; }
.side { padding: 20px 22px; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.src { background: var(--soft); }
.kv { display: grid; grid-template-columns: 82px 1fr; gap: 8px; font-size: 12.5px; color: var(--ink2); }
.kv span { color: var(--faint); }
.desc { font-size: 13px; line-height: 1.7; color: var(--ink2); border-top: 1px solid var(--line); padding-top: 10px; }
.out-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.pill { margin-left: auto; border-radius: 999px; padding: 5px 11px; font: 600 11.5px/1 var(--fb); }
.pill.ok { background: var(--grn-s); color: var(--grn); }
.pill.thin { background: var(--amb-s); color: var(--amb); }
.facts { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; }
.facts li { padding: 9px 0; border-bottom: 1px solid var(--line); display: grid; gap: 4px; }
.facts li:last-child { border-bottom: 0; }
.fact { font-size: 13.5px; font-weight: 500; }
.quote { font-size: 12px; color: var(--mut); }
.field { display: inline-block; font: 600 10px/1 var(--fb); letter-spacing: .06em; text-transform: uppercase; color: var(--pri); background: var(--pri-s); border-radius: 6px; padding: 3px 6px; margin-right: 7px; vertical-align: 1px; }
.none { color: var(--mut); font-size: 13px; }
@media (max-width: 760px) {
  .product, .profile { grid-template-columns: 1fr; }
  .count { margin-left: 0; }
}
</style>
<div class="wrap">
  <header>
    <p class="label">Sortiva · checkpoint 1 · built against fixture stores, ${new Date().toISOString().slice(0, 10)}</p>
    <h1 style="margin-top:10px">Are these facts true, and are they facts?</h1>
    <p class="lede">Ten made-up shops, five in English and five in Hungarian, were read the way a real install would read them. Each product's text went through one model call that lists only checkable statements. A statement was kept only if it quotes its source word for word and every number in it appears in that quote. Below, for each shop, five products as the merchant wrote them, beside what we kept. ${factCount} facts in all.</p>
  </header>
  <div class="ask">
    <p class="label">What to look for</p>
    <ul>
      <li>A fact that the product text does not support, or that changes a number or a unit.</li>
      <li>Marketing that slipped through as a fact (“perfect for”, “the best”, how the buyer will feel).</li>
      <li>A plain, checkable detail in the description that we missed.</li>
      <li>The Hungarian shops read as natural Hungarian, and their facts stay in Hungarian.</li>
    </ul>
    <p class="quote">These are fixture shops, not the dev store: no dev store exists yet. The same page can be produced from the dev store once the app is installed there.</p>
  </div>
  <nav class="index">${index.join('')}</nav>
  ${sections.join('')}
</div>
`
mkdirSync(new URL('../docs/checkpoints/', import.meta.url), { recursive: true })
writeFileSync(new URL('../docs/checkpoints/checkpoint-1-fact-sheets.html', import.meta.url), html)
console.log(`Wrote docs/checkpoints/checkpoint-1-fact-sheets.html (${stores.length} stores, ${factCount} facts shown)`)
await pool.end()
