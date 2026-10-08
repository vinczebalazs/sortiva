import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { optionalEnv } from '../config/env.ts'
import type { Language } from '../core/config.ts'
import { distil, type ProductForFacts } from '../core/learn/facts.ts'
import { mechanicalChecks, type Draft } from '../core/write/checks.ts'
import type { EvidencePack } from '../core/write/pack.ts'
import { judge, writeArticle, type GateReport, type Scores } from '../core/write/write.ts'
import { createTestDb } from '../db/test-db.ts'
import { startFakeAnthropic } from '../fakes/fake-anthropic/server.ts'
import { startPipeline } from '../scenarios/pipeline.ts'
import { AnthropicLlm } from '../vendors/anthropic/client.ts'
import { reviewPage, type WrittenArticle } from './review-page.ts'

/*
 * pnpm eval <distillation|judge|writer> [--record]
 * Answers come from the fake Anthropic's recordings; --record sends unrecorded requests to the real
 * API (needs ANTHROPIC_API_KEY and credit). A case with no recording is reported, not guessed.
 */

const suite = process.argv[1]?.endsWith('run.ts') ? process.argv[2] : undefined
const record = process.argv.includes('--record')
const out = new URL('./out/', import.meta.url)
mkdirSync(out, { recursive: true })
const read = <T>(path: string): T => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'))

type Row = Record<string, string | number>

function table(rows: Row[]): void {
  if (!rows.length) return
  const cols = Object.keys(rows[0]!)
  const width = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)))
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(width[i]!)).join('  ')
  console.log(line(cols))
  console.log(line(width.map((w) => '-'.repeat(w))))
  for (const r of rows) console.log(line(cols.map((c) => String(r[c] ?? ''))))
}

const unrecorded = (e: unknown) => /no recording|credit balance/i.test(String((e as Error)?.message ?? e))

async function llmFor() {
  const db = await createTestDb()
  const anthropic = await startFakeAnthropic({ record, apiKey: optionalEnv('ANTHROPIC_API_KEY') })
  const llm = new AnthropicLlm(db.pool, { apiKey: 'eval', baseURL: anthropic.url })
  const cost = async () => Number((await db.pool.query(`select coalesce(sum(cost_usd), 0) as c from llm_calls`)).rows[0].c)
  return { llm, cost, close: async () => (await anthropic.close(), await db.drop()) }
}

type DistillationCase = { id: string; language: Language; note: string; product: Omit<ProductForFacts, 'id'>; must: string[]; mustNot: string[] }

async function distillation() {
  const cases = [...read<DistillationCase[]>('./distillation/cases.en.json'), ...read<DistillationCase[]>('./distillation/cases.hu.json')]
  const { llm, cost, close } = await llmFor()
  const rows: Row[] = []
  const results = []
  for (const c of cases) {
    try {
      const { kept, dropped } = await distil(llm, null, c.language, { id: 0, ...c.product, tags: c.product.tags ?? [], options: c.product.options ?? [], metafields: c.product.metafields ?? [] })
      const texts = kept.map((f) => f.fact.toLowerCase())
      const missing = c.must.filter((m) => !texts.some((t) => t.includes(m.toLowerCase())))
      const leaked = c.mustNot.filter((m) => texts.some((t) => t.includes(m.toLowerCase())))
      const pass = missing.length === 0 && leaked.length === 0
      rows.push({ id: c.id, pass: pass ? 'yes' : 'NO', kept: kept.length, dropped: dropped.length, missing: missing.join(' | '), leaked: leaked.join(' | ') })
      results.push({ ...c, kept, dropped, missing, leaked, pass })
    } catch (e) {
      rows.push({ id: c.id, pass: unrecorded(e) ? 'not recorded' : 'ERROR', kept: '', dropped: '', missing: '', leaked: String((e as Error).message).slice(0, 60) })
    }
  }
  table(rows)
  summary(rows, 'pass', 'yes')
  console.log(`cost of new calls: ${(await cost()).toFixed(2)} USD`)
  writeFileSync(new URL('distillation.json', out), JSON.stringify(results, null, 2))
  await close()
}

type JudgeCase = {
  id: string
  language: Language
  note: string
  expect: 'pass' | 'fail'
  failOn: keyof Scores | 'information_gain' | 'general_numbers' | null
  store: { name: string; sells: string; audience: string; tone: string; neverSay: string }
  topic: { workingTitle: string; targetQuery: string }
  products: { ref: string; title: string; productType: string }[]
  facts: { ref: string; productRef: string; text: string }[]
  pages: { ref: string; kind: 'article' | 'page' | 'collection'; title: string }[]
  draft: Draft
}

function packOf(c: JudgeCase): EvidencePack {
  const host = 'eval-store.example'
  return {
    // No store row behind an eval case; the ledger records the calls without one.
    storeId: null as unknown as number,
    topicId: 0,
    language: c.language,
    storeName: c.store.name,
    hosts: [host],
    topic: { ...c.topic, searches: null, source: 'discovery' },
    profile: { sells: c.store.sells, audience: c.store.audience, tone: c.store.tone, neverSay: c.store.neverSay },
    products: c.products.map((p, i) => ({ ...p, id: i + 1, platformId: `eval/${p.ref}`, url: `https://${host}/products/${p.ref.toLowerCase()}`, images: [], core: true })),
    facts: c.facts.map((f, i) => ({ ...f, id: i + 1 })),
    links: [
      ...c.products.map((p) => ({ ref: p.ref, kind: 'product' as const, title: p.title, url: `https://${host}/products/${p.ref.toLowerCase()}` })),
      ...c.pages.map((p) => ({ ...p, url: `https://${host}/${p.kind}s/${p.ref.toLowerCase()}` })),
    ],
  }
}

const SCORE_KEY: Record<string, keyof Scores> = { grounding: 'grounding', information_gain: 'informationGain', structure: 'structure', fit: 'fit' }

async function judgeSuite() {
  const cases = read<JudgeCase[]>('./judge/cases.json')
  const { llm, cost, close } = await llmFor()
  const rows: Row[] = []
  const results = []
  for (const c of cases) {
    const pack = packOf(c)
    try {
      const verdict = await judge(llm, pack, c.draft, mechanicalChecks(c.draft, pack))
      const agreed = (verdict.passed ? 'pass' : 'fail') === c.expect
      // A fail case counts as caught for the right reason only if the intended dimension is the one that failed.
      const rightReason =
        c.expect === 'pass' || !c.failOn
          ? '—'
          : c.failOn === 'general_numbers'
            ? verdict.generalNumbers.some((g) => !g.accepted) ? 'yes' : 'no'
            : verdict.scores[SCORE_KEY[c.failOn]!] < (c.failOn === 'grounding' || c.failOn === 'information_gain' ? 4 : 3) ? 'yes' : 'no'
      const s = verdict.scores
      rows.push({ id: c.id, expect: c.expect, got: verdict.passed ? 'pass' : 'fail', agree: agreed ? 'yes' : 'NO', reason: rightReason, scores: `${s.grounding}/${s.informationGain}/${s.structure}/${s.fit}`, failOn: c.failOn ?? '' })
      results.push({ id: c.id, note: c.note, expect: c.expect, failOn: c.failOn, verdict })
    } catch (e) {
      rows.push({ id: c.id, expect: c.expect, got: unrecorded(e) ? 'not recorded' : 'ERROR', agree: '', reason: '', scores: '', failOn: String((e as Error).message).slice(0, 60) })
    }
  }
  table(rows)
  summary(rows, 'agree', 'yes')
  console.log('scores are grounding / information gain / structure / fit')
  console.log(`cost of new calls: ${(await cost()).toFixed(2)} USD`)
  writeFileSync(new URL('judge.json', out), JSON.stringify(results, null, 2))
  await close()
}

type WriterCase = { id: string; language: Language; fixture: string; topic: number }

/** Writes each case's topic through the real write stage, on the fixture shop as the scenarios set it up. */
export async function writeCases(cases: WriterCase[]): Promise<{ rows: Row[]; articles: WrittenArticle[] }> {
  const rows: Row[] = []
  const articles: WrittenArticle[] = []
  const byFixture = new Map<string, WriterCase[]>()
  for (const c of cases) byFixture.set(c.fixture, [...(byFixture.get(c.fixture) ?? []), c])
  if (record) process.env.RECORD = '1'
  for (const [fixture, group] of byFixture) {
    const p = await startPipeline()
    try {
      const { id: storeId } = await p.install(fixture)
      await p.settle()
      await p.completeSetup(storeId)
      await p.settle(300_000)
      const { rows: topics } = await p.db.pool.query<{ id: number; target_query: string; working_title: string; demand: number | null }>(
        `select id::int, target_query, working_title, demand from topics where store_id = $1 and state = 'queued' order by manual_position asc nulls last, rank desc, id`,
        [storeId],
      )
      for (const c of group) {
        const topic = topics[c.topic - 1]
        if (!topic) {
          rows.push({ id: c.id, outcome: 'no such topic', query: '', attempts: '', scores: '', held: '' })
          continue
        }
        await p.db.pool.query(`update topics set state = 'scheduled' where id = $1`, [topic.id])
        try {
          const result = await writeArticle({ db: p.db.pool, llm: p.deps.llm }, storeId, topic.id)
          const { rows: a } = await p.db.pool.query<{ title: string; html: string | null; markdown: string | null; gate_report: GateReport }>(
            `select title, html, markdown, gate_report from articles where id = $1`,
            [result.articleId],
          )
          const report = a[0]!.gate_report
          const s = report.attempts.at(-1)?.judge?.scores
          rows.push({ id: c.id, outcome: result.outcome, query: topic.target_query, attempts: report.attempts.length, scores: s ? `${s.grounding}/${s.informationGain}/${s.structure}/${s.fit}` : '', held: result.heldReason ?? '' })
          articles.push({ id: c.id, fixture, language: c.language, query: topic.target_query, searches: topic.demand, title: a[0]!.title, html: a[0]!.html, markdown: a[0]!.markdown, report })
        } catch (e) {
          rows.push({ id: c.id, outcome: unrecorded(e) ? 'not recorded' : 'ERROR', query: topic.target_query, attempts: '', scores: '', held: unrecorded(e) ? '' : String((e as Error).message).slice(0, 60) })
        }
      }
      const { rows: spent } = await p.db.pool.query(`select coalesce(sum(cost_usd), 0)::float as c from llm_calls where prompt_name in ('plan-article', 'draft-article', 'repair-article', 'judge-article')`)
      console.error(`${fixture}: writing calls cost ${spent[0].c.toFixed(2)} USD (recorded or new)`)
    } finally {
      await p.stop()
    }
  }
  return { rows, articles }
}

async function writer() {
  const cases = read<WriterCase[]>('./writer/cases.json')
  const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7)
  const { rows, articles } = await writeCases(only ? cases.filter((c) => c.id.startsWith(only)) : cases)
  table(rows)
  summary(rows, 'outcome', 'passed')
  console.log('scores are grounding / information gain / structure / fit')
  writeFileSync(new URL('writer.json', out), JSON.stringify(articles, null, 2))
  writeFileSync(new URL('writer.html', out), reviewPage('Writer eval', articles))
  console.log(`review page: evals/out/writer.html`)
}

function summary(rows: Row[], col: string, good: string): void {
  const ran = rows.filter((r) => r[col] !== '' && !['not recorded', 'ERROR', 'no such topic'].includes(String(r.pass ?? r.got ?? r.outcome)))
  const ok = rows.filter((r) => r[col] === good).length
  const missing = rows.filter((r) => Object.values(r).includes('not recorded')).length
  console.log(`\n${ok} of ${ran.length} run cases ${col === 'agree' ? 'agree with the expected verdict' : col === 'outcome' ? 'passed the gate' : 'passed'}; ${missing} not recorded (run with --record and Anthropic credit).`)
}

if (suite === 'distillation') await distillation()
else if (suite === 'judge') await judgeSuite()
else if (suite === 'writer') await writer()
else if (suite) {
  console.error('usage: pnpm eval <distillation|judge|writer> [--record] [--only=<id prefix>]')
  process.exit(1)
}
