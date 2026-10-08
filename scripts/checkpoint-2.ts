import { mkdirSync, writeFileSync } from 'node:fs'
import { MESSAGES } from '../app/i18n/messages.ts'
import { formatNumber } from '../app/ui/format.ts'
import { whyLine, type Evidence } from '../core/topics/evidence.ts'
import type { DiscoveryOutcome } from '../core/topics/discover.ts'
import { createPool } from '../db/pool.ts'

/**
 * Checkpoint 2's review page: the queue of every set-up store in the local database, with the
 * numbers behind each topic and what topic-finding proposed but left out, and why.
 * Run `pnpm seed:preview rich-hu:done rich-en:done` first.
 */
const pool = createPool()
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const DROP_WORDS: Record<string, string> = {
  already_ours: 'Already in the queue',
  not_interested: 'Marked not interested',
  existing_page: 'The store already has a page on it',
  below_demand_floor: 'Too few searches',
  only_product_listings: 'Google shows only shop listings',
  same_intent: 'Same search intent as a better topic',
  over_cap: 'Queue full',
}

const stores = (
  await pool.query<{ id: number; name: string; country: string; language: 'en' | 'hu'; sells: string; audience: string; tone: string }>(
    `select s.id::int, s.name, p.country, p.language, p.sells, p.audience, p.tone
     from stores s join store_profile p on p.store_id = s.id where s.setup_step = 'done' order by p.language desc, s.id`,
  )
).rows

let queuedTotal = 0
let proposedTotal = 0
const sections: string[] = []
for (const store of stores) {
  const t = MESSAGES[store.language]
  const floor = store.language === 'hu' ? 20 : 100
  const topics = (
    await pool.query<{ working_title: string; target_query: string; demand: number; evidence: Evidence; source: 'discovery' | 'manual'; products: string[] }>(
      `select t.working_title, t.target_query, t.demand, t.evidence, t.source,
              (select array_agg(p.title order by p.id) from products p where p.id = any(t.product_ids)) as products
       from topics t where t.store_id = $1 and t.state = 'queued' order by t.manual_position nulls last, t.rank desc, t.id`,
      [store.id],
    )
  ).rows
  const run = (await pool.query<{ output: DiscoveryOutcome }>(`select output from job_ledger where task = 'find_topics' and store_id = $1 order by completed_at desc limit 1`, [store.id])).rows[0]?.output
  const dropped = run?.ran ? run.dropped : []
  queuedTotal += topics.length
  proposedTotal += run?.ran ? run.proposed : 0

  const rows = topics.map((topic, i) => {
    const why = whyLine(topic.evidence, topic.source)
    const sentence = why.kind === 'demand_no_page' ? t.home.why.demand_no_page(formatNumber(why.searches, store.language)) : t.home.why.low_demand_manual
    const top = topic.evidence.topResults
    return `
      <li class="topic">
        <span class="pos">${i + 1}</span>
        <div class="topic-body">
          <h3>${esc(topic.working_title)}</h3>
          <p class="query"><span class="q">${esc(topic.target_query)}</span><span class="num">${formatNumber(topic.demand, 'en')} searches a month</span></p>
          <p class="why">${esc(sentence)}</p>
          <div class="meta">
            <div><p class="label">Products it mentions</p><p>${(topic.products ?? []).map(esc).join(' · ')}</p></div>
            <div><p class="label">Facts behind it</p><p class="num">${topic.evidence.facts.value}</p></div>
            <div><p class="label">Google's top three</p><ol class="urls">${(top?.top3 ?? []).map((u) => { const cut = u.indexOf('/'); return `<li><b>${esc(cut < 0 ? u : u.slice(0, cut))}</b>${esc(cut < 0 ? '' : u.slice(cut))}</li>` }).join('')}</ol></div>
            <div><p class="label">Shop listings in the top ten</p><p class="num">${top ? `${top.productListings} of ${top.of}` : '—'}</p></div>
          </div>
        </div>
      </li>`
  })
  const dropRows = dropped
    .slice()
    .sort((a, b) => a.reason.localeCompare(b.reason) || a.query.localeCompare(b.query))
    .map((d) => {
      const figure = d.reason === 'below_demand_floor' ? (d.detail === 'none' ? 'no figure' : `${d.detail} a month`) : (d.detail ?? '')
      return `<tr><td>${esc(d.query)}</td><td>${esc(DROP_WORDS[d.reason] ?? d.reason)}</td><td class="num">${esc(figure)}</td></tr>`
    })

  sections.push(`
    <section class="store" id="store-${store.id}">
      <div class="store-head">
        <div>
          <p class="label">${store.language === 'hu' ? 'Hungarian' : 'English'} · customers in ${esc(store.country)} · minimum ${floor} searches a month</p>
          <h2>${esc(store.name)}</h2>
        </div>
        <span class="count">${topics.length} queued of ${run?.ran ? run.proposed : 0} proposed</span>
      </div>
      <div class="profile">
        <div><p class="label">What it sells (as confirmed)</p><p>${esc(store.sells)}</p></div>
        <div><p class="label">Who buys it</p><p>${esc(store.audience)}</p></div>
      </div>
      <ol class="queue">${rows.join('')}</ol>
      ${
        dropRows.length
          ? `<details class="dropped"${store.language === 'hu' ? ' open' : ''}>
        <summary><span class="label">Proposed but not queued</span> <span class="num">${dropRows.length}</span></summary>
        <div class="scroll"><table><thead><tr><th>Search phrase</th><th>Why it was left out</th><th>Figure</th></tr></thead><tbody>${dropRows.join('')}</tbody></table></div>
      </details>`
          : ''
      }
    </section>`)
}

const html = `<title>Checkpoint 2 Topic Queues</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Poppins:wght@500;600&family=Plus+Jakarta+Sans:wght@400;500;600&display=swap">
<style>
/* Layout: one column per shop; the queue reads like the app's Up next list, with the evidence opened out under each topic. Look: the app's own mockup tokens. */
:root {
  --ground: #e8e9f0; --card: #ffffff; --ink: #191b23; --ink2: #454a5c; --mut: #6f7488; --faint: #878da0;
  --line: #edeef3; --soft: #f5f6fa; --pri: #6470f3; --pri-s: #eeeffe; --amb: #9a5d07; --amb-s: #fdf3e4;
  --sh: 0 1px 2px rgba(21,25,42,.04), 0 8px 24px -6px rgba(21,25,42,.08);
  --fh: 'Poppins', system-ui, sans-serif; --fb: 'Plus Jakarta Sans', system-ui, sans-serif;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --ground: #14151b; --card: #1d1f27; --ink: #ecedf3; --ink2: #c3c6d4; --mut: #9a9fb2; --faint: #7c8196;
  --line: #2a2d38; --soft: #252833; --pri: #8f97f7; --pri-s: #262a4a; --amb: #f0b45a; --amb-s: #3a2e18;
  --sh: 0 1px 2px rgba(0,0,0,.3), 0 8px 24px -6px rgba(0,0,0,.4); color-scheme: dark } }
:root[data-theme="dark"] {
  --ground: #14151b; --card: #1d1f27; --ink: #ecedf3; --ink2: #c3c6d4; --mut: #9a9fb2; --faint: #7c8196;
  --line: #2a2d38; --soft: #252833; --pri: #8f97f7; --pri-s: #262a4a; --amb: #f0b45a; --amb-s: #3a2e18;
  --sh: 0 1px 2px rgba(0,0,0,.3), 0 8px 24px -6px rgba(0,0,0,.4); color-scheme: dark }
body { background: var(--ground); color: var(--ink); font: 400 14px/1.6 var(--fb); }
.wrap { max-width: 1040px; margin: 0 auto; padding-inline: 20px; padding-block: 36px 80px; display: flex; flex-direction: column; gap: 28px; }
h1, h2, h3 { font-family: var(--fh); font-weight: 500; letter-spacing: -.015em; text-wrap: balance; margin: 0; }
h1 { font-size: 32px; line-height: 1.15; }
h2 { font-size: 22px; }
h3 { font-size: 16.5px; line-height: 1.3; }
p { margin: 0; }
.num { font-variant-numeric: tabular-nums; }
.label { font: 600 11px/1 var(--fb); letter-spacing: .08em; text-transform: uppercase; color: var(--faint); }
.lede { max-width: 68ch; color: var(--ink2); font-size: 15px; margin-top: 10px; }
.panel { background: var(--card); border-radius: 18px; box-shadow: var(--sh); padding: 20px 22px; display: grid; gap: 10px; }
.panel ul { margin: 0; padding-left: 18px; color: var(--ink2); display: grid; gap: 4px; }
.finding { background: var(--amb-s); }
.finding p, .finding li { color: var(--ink); }
.store { display: flex; flex-direction: column; gap: 14px; }
.store-head { display: flex; align-items: flex-end; gap: 12px; flex-wrap: wrap; padding-top: 18px; border-top: 1px solid var(--line); }
.store-head > div { display: grid; gap: 8px; }
.count { margin-left: auto; font: 600 12px/1 var(--fb); color: var(--ink2); background: var(--card); border-radius: 999px; padding: 8px 12px; box-shadow: var(--sh); font-variant-numeric: tabular-nums; }
.profile { background: var(--card); border-radius: 18px; box-shadow: var(--sh); padding: 18px 20px; display: grid; grid-template-columns: 1.4fr 1fr; gap: 18px; }
.profile > div { display: grid; gap: 7px; align-content: start; min-width: 0; }
.profile p:not(.label) { color: var(--ink2); font-size: 13.5px; }
.queue { list-style: none; margin: 0; padding: 0; background: var(--card); border-radius: 18px; box-shadow: var(--sh); padding-inline: 22px; }
.topic { display: grid; grid-template-columns: 30px minmax(0, 1fr); gap: 14px; padding-block: 20px; border-bottom: 1px solid var(--line); }
.topic:last-child { border-bottom: 0; }
.pos { width: 28px; height: 28px; border-radius: 50%; background: var(--pri-s); color: var(--pri); display: grid; place-items: center; font: 600 12.5px/1 var(--fb); }
.topic-body { display: grid; gap: 9px; min-width: 0; }
.query { display: flex; gap: 10px; flex-wrap: wrap; align-items: baseline; font-size: 13px; color: var(--mut); }
.q { font-weight: 600; color: var(--ink2); }
.why { background: var(--soft); border-radius: 11px; padding: 10px 12px; font-size: 13px; color: var(--ink2); }
.meta { display: grid; grid-template-columns: 1.3fr .5fr 1.6fr .7fr; gap: 16px; font-size: 12.5px; color: var(--ink2); }
.meta > div { display: grid; gap: 6px; align-content: start; min-width: 0; }
.urls { margin: 0; padding-left: 16px; display: grid; gap: 2px; overflow-wrap: anywhere; color: var(--mut); }
.urls b { font-weight: 600; color: var(--ink2); }
.dropped { background: var(--card); border-radius: 18px; box-shadow: var(--sh); padding: 16px 22px; }
.dropped summary { cursor: pointer; display: flex; gap: 10px; align-items: center; }
.dropped summary:focus-visible { outline: 2px solid var(--pri); outline-offset: 4px; border-radius: 6px; }
.scroll { overflow-x: auto; margin-top: 12px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th { text-align: left; font: 600 11px/1 var(--fb); letter-spacing: .08em; text-transform: uppercase; color: var(--faint); padding: 0 12px 10px 0; }
td { padding: 9px 12px 9px 0; border-top: 1px solid var(--line); color: var(--ink2); }
td:first-child { color: var(--ink); font-weight: 500; }
@media (max-width: 760px) {
  .profile, .meta { grid-template-columns: 1fr; }
  .count { margin-left: 0; }
}
</style>
<div class="wrap">
  <header>
    <p class="label">Sortiva · checkpoint 2 · fixture shops, real Google demand, ${new Date().toISOString().slice(0, 10)}</p>
    <h1 style="margin-top:10px">Are these topics a merchant would want? Are the why lines true?</h1>
    <p class="lede">Two made-up shops, one Hungarian and one English, went through setup the way a merchant would. The model then proposed article topics from each shop's checked product facts. Every topic's monthly searches and Google's top ten results are real, fetched from DataForSEO for the shop's country and language on ${new Date().toISOString().slice(0, 10)}. Below is each shop's queue in the order it would be written, one a day, with the numbers behind every topic and what was proposed but left out. ${queuedTotal} queued of ${proposedTotal} proposed.</p>
  </header>
  <div class="panel finding">
    <p class="label">The main finding</p>
    <p>Most proposed topics were left out because Google reports almost nobody searching for the exact phrase the model chose. Many phrases have no figure at all, which Google Ads gives for very rare searches. The topics are sensible; their wording is too specific. A decision for you:</p>
    <ul>
      <li><b>Ask the model for two or three phrasings per topic</b> and keep the one people search most. It costs nothing extra, because all phrasings go in the same single demand request. This is my recommendation.</li>
      <li><b>Lower the minimum</b> from 100 (English) and 20 (Hungarian) searches a month. Articles would then target phrases almost nobody types.</li>
      <li><b>Keep it as it is.</b> Fewer, safer topics; a rich shop would run dry in about a week.</li>
    </ul>
  </div>
  <div class="panel">
    <p class="label">What to look for</p>
    <ul>
      <li>A topic the shop could not write well from its own products, or one a shopper would not care about.</li>
      <li>A why line that overstates. It says only how many people search and that the shop has no page on it.</li>
      <li>A good topic in the "proposed but not queued" list that should have made it.</li>
      <li>The Hungarian phrases read as things a Hungarian shopper would type.</li>
    </ul>
  </div>
  ${sections.join('')}
</div>
`
mkdirSync(new URL('../docs/checkpoints/', import.meta.url), { recursive: true })
writeFileSync(new URL('../docs/checkpoints/checkpoint-2-queues.html', import.meta.url), html)
console.log(`Wrote docs/checkpoints/checkpoint-2-queues.html (${stores.length} stores, ${queuedTotal} topics)`)
await pool.end()
