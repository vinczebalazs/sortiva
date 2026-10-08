import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { loadPack } from '../../core/write/pack.ts'
import { startPipeline, type Pipeline } from '../pipeline.ts'
import { answerOf, articlesOf, isDraftFor, isJudgeFor, isRepairFor, recordedDraftIn, resetDay, seedDraft, withText } from './seed.ts'

let p: Pipeline
let storeId: number
let first: { id: number; query: string; product: string }
let second: { id: number; query: string }

beforeAll(async () => {
  p = await startPipeline()
  storeId = (await p.install('rich-en')).id
  await p.settle()
  await p.completeSetup(storeId)
  await p.settle(300_000)
  const { rows } = await p.db.pool.query<{ id: number; target_query: string }>(
    `select id::int, target_query from topics where store_id = $1 and state = 'queued' order by manual_position asc nulls last, rank desc, id limit 2`,
    [storeId],
  )
  const pack = await loadPack(p.db.pool, storeId, rows[0]!.id)
  first = { id: rows[0]!.id, query: rows[0]!.target_query, product: pack.products[0]!.title }
  second = { id: rows[1]!.id, query: rows[1]!.target_query }
}, 600_000)
afterAll(() => p?.stop())
beforeEach(() => resetDay(p, storeId))

async function writeToday() {
  await p.writeToday(storeId)
  await p.settle(900_000)
  // Every seeded answer must have been used, or a later scenario would receive it.
  expect(p.anthropic.pendingOverrides()).toBe(0)
  return articlesOf(p, storeId)
}

const addToFirstParagraph = (sentence: string) => (md: string) => md.replace(/\n\n/, ` ${sentence}\n\n`)

describe('the gate holds a draft whose flaw survives the one repair, and says why', () => {
  const cases: [string, (md: string) => string, string][] = [
    ['an uncited product claim', (md) => addToFirstParagraph(`The ${first.product} is the finest of its kind anywhere.`)(md), 'claims_cited'],
    ['an uncited number', addToFirstParagraph('Most people get it right after 7 attempts.'), 'numbers_cited'],
    ['a first-person experience sentence', addToFirstParagraph('We tested this method for months before writing it down.'), 'no_experience'],
    ['a link leaving the store', addToFirstParagraph('There is more in [this guide](https://www.example.com/coffee-guide).'), 'links_internal'],
    ['a price in the text', addToFirstParagraph('A good setup costs less than £40 in total.'), 'no_price'],
  ]
  for (const [name, mutate, reason] of cases) {
    it(`${name} is held with reason ${reason}, and the day tries one more topic`, async () => {
      seedDraft(p, 'en', first.query, mutate)
      const articles = await writeToday()
      const held = articles.find((a) => a.topic_id === first.id)!
      expect(held.state).toBe('held')
      expect(held.held_reason).toBe(reason)
      expect(held.gate_report.heldReason).toBe(reason)
      // Exactly one repair was tried before holding.
      expect(held.gate_report.attempts).toHaveLength(2)
      // A held article costs the merchant nothing: the next topic is written the same day, once.
      const { rows } = await p.db.pool.query(`select topic_id::int, retry_topic_id::int from schedule_days where store_id = $1`, [storeId])
      expect(rows).toEqual([{ topic_id: first.id, retry_topic_id: second.id }])
      expect(articles.map((a) => a.topic_id)).toEqual([first.id, second.id])
    }, 900_000)
  }

  it('an article in the wrong language is held', async () => {
    const hungarian = recordedDraftIn('hu')
    p.anthropic.override(isDraftFor('en', first.query), (rec) => withText(rec, JSON.stringify(hungarian)))
    p.anthropic.override(isRepairFor('en', first.query), (rec) => withText(rec, JSON.stringify(hungarian)))
    const articles = await writeToday()
    expect(articles.find((a) => a.topic_id === first.id)).toMatchObject({ state: 'held', held_reason: 'language' })
  }, 900_000)

  it('a malformed model answer is retried once with the shape shown, then the article is held, not crashed', async () => {
    p.anthropic.override(isDraftFor('en', first.query), (rec) => withText(rec, 'Here is your article: # How to'))
    p.anthropic.override(isDraftFor('en', first.query), (rec) => withText(rec, '{"title": "unfinished'))
    const articles = await writeToday()
    expect(articles.find((a) => a.topic_id === first.id)).toMatchObject({ state: 'held', held_reason: 'malformed' })
  }, 900_000)

  it('the judge failing twice holds the article with the second set of notes', async () => {
    const failing = (note: string) => (rec: Parameters<typeof withText>[0]) => {
      const answer = answerOf(rec) as Record<string, { score: number; note: string }>
      return withText(rec, JSON.stringify({ ...answer, information_gain: { score: 2, note }, problems: [{ quote: 'whole article', problem: note }], general_numbers: [] }))
    }
    p.anthropic.override(isJudgeFor('en', first.query), failing('first notes: too generic'))
    p.anthropic.override(isJudgeFor('en', first.query), failing('second notes: still too generic'))
    const articles = await writeToday()
    const held = articles.find((a) => a.topic_id === first.id)!
    expect(held).toMatchObject({ state: 'held', held_reason: 'judge' })
    expect(held.gate_report.heldProblem!.detail).toBe('second notes: still too generic')
  }, 900_000)
})

describe('one repair for any failure, and at most two tries a day', () => {
  it('a draft failing a mechanical check gets one repair, and the repaired draft can pass', async () => {
    seedDraft(p, 'en', first.query, addToFirstParagraph('Most people get it right after 7 attempts.'), { repairToo: false })
    const articles = await writeToday()
    const article = articles.find((a) => a.topic_id === first.id)!
    expect(article.gate_report.attempts).toHaveLength(2)
    expect(article.state, JSON.stringify([article.gate_report.heldReason, article.gate_report.heldProblem])).toBe('ready')
    expect(articles).toHaveLength(1)
  }, 900_000)

  it('when the second topic of the day is held too, the day ends there', async () => {
    seedDraft(p, 'en', first.query, addToFirstParagraph('A good setup costs less than £40 in total.'))
    seedDraft(p, 'en', second.query, addToFirstParagraph('A good setup costs less than £40 in total.'))
    const articles = await writeToday()
    expect(articles.map((a) => [a.topic_id, a.state])).toEqual([
      [first.id, 'held'],
      [second.id, 'held'],
    ])
    const { rows } = await p.db.pool.query(`select count(*)::int as n from topics where store_id = $1 and state = 'scheduled'`, [storeId])
    expect(rows[0].n).toBe(0)
  }, 900_000)
})
