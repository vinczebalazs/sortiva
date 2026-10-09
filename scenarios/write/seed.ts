import { readdirSync, readFileSync } from 'node:fs'
import type { Recording } from '../../fakes/fake-anthropic/server.ts'
import type { Language } from '../../core/config.ts'
import { DRAFT_PROMPT, JUDGE_PROMPT, REPAIR_PROMPT } from '../../core/write/prompts.ts'
import type { Pipeline } from '../pipeline.ts'

type Message = { content: { type: string; text?: string }[] }
type Request = Record<string, unknown>

/** A recorded model answer with its text swapped: the envelope (ids, usage, stop reason) stays the real one. */
export function withText(recorded: Recording, text: string): unknown {
  const response = structuredClone(recorded.response) as Message
  let replaced = false
  response.content = response.content.flatMap((b) => {
    if (b.type !== 'text') return [b]
    if (replaced) return []
    replaced = true
    return [{ ...b, text }]
  })
  return response
}

export function answerOf(recorded: Recording): Record<string, unknown> {
  const text = (recorded.response as Message).content.filter((b) => b.type === 'text').map((b) => b.text).join('')
  return JSON.parse(text)
}

const userText = (request: Request) => JSON.stringify(request.messages)

export const isDraftFor = (language: Language, query: string) => (r: Request) => r.system === DRAFT_PROMPT.system[language] && userText(r).includes(query)
export const isRepairFor = (language: Language, query: string) => (r: Request) => r.system === REPAIR_PROMPT.system[language] && userText(r).includes(query)
export const isJudgeFor = (language: Language, query: string) => (r: Request) => r.system === JUDGE_PROMPT.system[language] && userText(r).includes(query)

/**
 * A recorded writer answer that passed every free check and the reviewer (see `_source` in each file).
 * Seeding from it keeps a scenario about one flaw independent of how today's prompt happens to write.
 */
export function cleanDraft(name: 'rich-en-french-press' | 'rich-hu-zold-tea'): Record<string, unknown> {
  const { _source, ...answer } = JSON.parse(readFileSync(new URL(`./drafts/${name}.json`, import.meta.url), 'utf8'))
  return answer
}

/**
 * A clean draft for the topic, altered by `mutate`, served for the draft call and, unless told
 * otherwise, again for the one repair, so the flaw survives both and the article must be held.
 */
export function seedDraft(p: Pipeline, language: Language, query: string, base: Record<string, unknown>, mutate: (markdown: string) => string = (md) => md, opts: { repairToo?: boolean } = {}): void {
  const seeded = { ...base, markdown: mutate(String(base.markdown)) }
  p.anthropic.override(isDraftFor(language, query), (recorded) => withText(recorded, JSON.stringify(seeded)))
  if (opts.repairToo !== false) {
    p.anthropic.override(isRepairFor(language, query), (recorded) => withText(recorded, JSON.stringify(seeded)))
  }
}

/** A real recorded draft written for a store in another language: the writer answering in the wrong language. */
export function recordedDraftIn(language: Language): Record<string, unknown> {
  const dir = new URL('../../fakes/fake-anthropic/recordings/', import.meta.url)
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue
    const rec = JSON.parse(readFileSync(new URL(name, dir), 'utf8')) as Recording
    if (rec.status !== 200 || rec.request.system !== DRAFT_PROMPT.system[language]) continue
    try {
      return answerOf(rec)
    } catch {
      // A shape failure the writer was asked to correct; not a usable draft.
    }
  }
  throw new Error(`no recorded ${language} draft; run the ${language} writing scenario with RECORD=1 first`)
}

/** Puts the store back to before today's writing, so the next scenario writes the same topic from the same recordings. */
export async function resetDay(p: Pipeline, storeId: number): Promise<void> {
  const db = p.db.pool
  await db.query(`delete from schedule_days where store_id = $1`, [storeId])
  await db.query(`delete from articles where store_id = $1`, [storeId])
  await db.query(`update topics set state = 'queued', held_reason = null, scheduled_for = null where store_id = $1 and state in ('scheduled', 'written', 'held', 'vetoed')`, [storeId])
  await db.query(`delete from not_interested where store_id = $1`, [storeId])
  await db.query(`delete from job_ledger where store_id = $1 and task in ('write_article', 'daily_pick')`, [storeId])
  await db.query(`update store_flags set write_failed_at = null, write_failure = null where store_id = $1`, [storeId])
  // Answers are reused by request; the seeded ones must reach the fake again, so the writing calls are forgotten.
  await db.query(`delete from llm_calls where prompt_name in ('draft-article', 'repair-article', 'judge-article')`)
}

export async function articlesOf(p: Pipeline, storeId: number) {
  const { rows } = await p.db.pool.query<{
    id: number
    state: string
    topic_id: number
    target_query: string
    held_reason: string | null
    gate_report: { heldReason: string | null; heldProblem: { sentence?: string; detail: string } | null; attempts: unknown[] }
    html: string | null
  }>(
    `select a.id::int, a.state, a.topic_id::int, t.target_query, t.held_reason, a.gate_report, a.html
     from articles a join topics t on t.id = a.topic_id where a.store_id = $1 order by a.id`,
    [storeId],
  )
  return rows
}
