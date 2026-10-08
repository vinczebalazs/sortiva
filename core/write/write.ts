import type { Db } from '../../db/pool.ts'
import { CONFIG } from '../config.ts'
import { MalformedOutputError, ModelRefusedError } from '../errors.ts'
import type { Llm } from '../llm.ts'
import { foldAccents } from '../topics/canonical.ts'
import { mechanicalChecks, type CheckId, type Draft, type MechanicalReport, type Problem } from './checks.ts'
import { finalMarkdown, renderHtml, sentences } from './markup.ts'
import { loadPack, packText, type EvidencePack } from './pack.ts'
import { DRAFT_PROMPT, JUDGE_PROMPT, PLAN_PROMPT, REPAIR_PROMPT, draftSchema, judgeSchema, planSchema, type Plan } from './prompts.ts'

export type WriteDeps = { db: Db; llm: Llm }

export type Scores = { grounding: number; informationGain: number; structure: number; fit: number }

export type JudgeVerdict = {
  scores: Scores
  notes: Record<keyof Scores, string>
  problems: Problem[]
  generalNumbers: { sentence: string; numbers: string[]; accepted: boolean; reason: string }[]
  passed: boolean
}

export type Attempt = { draft: Draft; mechanical: MechanicalReport; judge: JudgeVerdict | null }

/** Why an article was held; the screens hold one plain sentence for each. */
export type HeldReason = CheckId | 'judge' | 'general_numbers' | 'too_few_facts' | 'malformed' | 'refused'

export type GateReport = {
  outcome: 'passed' | 'held'
  heldReason: HeldReason | null
  /** The problem that decided it, with the sentence that caused it when there is one. */
  heldProblem: Problem | null
  attempts: Attempt[]
}

export type WriteOutcome = { articleId: number; outcome: 'passed' | 'held'; heldReason: HeldReason | null }

export function slugify(raw: string): string {
  return foldAccents(raw.toLowerCase())
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '')
}

function toDraft(answer: { title: string; meta_description: string; slug: string; markdown: string }): Draft {
  return { title: answer.title.trim(), metaDescription: answer.meta_description.trim(), slug: slugify(answer.slug || answer.title), markdown: answer.markdown.trim() }
}

function draftText(d: Draft): string {
  return `<draft>\nTitle: ${d.title}\nMeta description: ${d.metaDescription}\nSlug: ${d.slug}\n\n${d.markdown}\n</draft>`
}

function planText(plan: Plan): string {
  return `<plan>\nTitle: ${plan.title}\nAngle: ${plan.angle}\n${plan.sections.map((s) => `## ${s.heading}\n   ${s.covers} (${s.facts.join(', ') || '—'})`).join('\n')}\nProduct cards: ${plan.products.join(', ') || '—'}\nLinks: ${plan.links.join(', ') || '—'}\n</plan>`
}

export async function judge(llm: Llm, pack: EvidencePack, draft: Draft, mechanical: MechanicalReport): Promise<JudgeVerdict> {
  const general = mechanical.generalNumbers
  const user = [
    packText(pack),
    `<article>\nTitle: ${draft.title}\n\n${draft.markdown}\n</article>`,
    `<general_knowledge>\n${general.length ? general.map((g, i) => `G${i + 1}: ${g.sentence} (numbers: ${g.numbers.join(', ')})`).join('\n') : '—'}\n</general_knowledge>`,
  ].join('\n\n')
  const answer = await llm.json({
    storeId: pack.storeId,
    prompt: { name: JUDGE_PROMPT.name, version: JUDGE_PROMPT.version },
    system: JUDGE_PROMPT.system[pack.language],
    user,
    schema: judgeSchema,
    effort: 'medium',
    maxTokens: 8_000,
  })
  const scores: Scores = { grounding: answer.grounding.score, informationGain: answer.information_gain.score, structure: answer.structure.score, fit: answer.fit.score }
  const f = CONFIG.judgeFloors
  const generalNumbers = general.map((g, i) => {
    const v = answer.general_numbers.find((x) => x.ref.trim().toUpperCase() === `G${i + 1}`)
    return { ...g, accepted: v?.accepted ?? false, reason: v?.reason ?? 'not assessed' }
  })
  const passed = scores.grounding >= f.grounding && scores.informationGain >= f.informationGain && scores.structure >= f.other && scores.fit >= f.other && generalNumbers.every((g) => g.accepted)
  return {
    scores,
    notes: { grounding: answer.grounding.note, informationGain: answer.information_gain.note, structure: answer.structure.note, fit: answer.fit.note },
    problems: answer.problems.map((p) => ({ sentence: p.quote, detail: p.problem })),
    generalNumbers,
    passed,
  }
}

function failures(a: Attempt): Problem[] {
  const out = a.mechanical.checks.flatMap((c) => c.problems.map((p) => ({ ...p, detail: `${c.id}: ${p.detail}` })))
  if (a.judge && !a.judge.passed) {
    const f = CONFIG.judgeFloors
    const low = (Object.keys(a.judge.scores) as (keyof Scores)[]).filter((k) => a.judge!.scores[k] < (k === 'grounding' ? f.grounding : k === 'informationGain' ? f.informationGain : f.other))
    out.push(...low.map((k) => ({ detail: `review, ${k} ${a.judge!.scores[k]}/5: ${a.judge!.notes[k]}` })))
    out.push(...a.judge.generalNumbers.filter((g) => !g.accepted).map((g) => ({ sentence: g.sentence, detail: `not accepted as general knowledge: ${g.reason}` })))
    out.push(...a.judge.problems)
  }
  return out
}

function passed(a: Attempt): boolean {
  return a.mechanical.checks.every((c) => c.ok) && !!a.judge?.passed
}

function heldBy(a: Attempt): { reason: HeldReason; problem: Problem | null } {
  const failed = a.mechanical.checks.find((c) => !c.ok)
  if (failed) return { reason: failed.id, problem: failed.problems[0] ?? null }
  const unaccepted = a.judge?.generalNumbers.find((g) => !g.accepted)
  if (unaccepted) return { reason: 'general_numbers', problem: { sentence: unaccepted.sentence, detail: unaccepted.reason } }
  return { reason: 'judge', problem: a.judge?.problems[0] ?? null }
}

async function attempt(llm: Llm, pack: EvidencePack, draft: Draft): Promise<Attempt> {
  const mechanical = mechanicalChecks(draft, pack)
  // The judge costs a call; a draft that already failed a free check goes straight to repair.
  const judgeVerdict = mechanical.checks.every((c) => c.ok) ? await judge(llm, pack, draft, mechanical) : null
  return { draft, mechanical, judge: judgeVerdict }
}

/**
 * Writes the article for one scheduled topic and gates it: free checks, then the blind judge,
 * then at most one repair for any failure (founder, 2026-10-08), then pass or hold with a reason.
 * Nothing falls back to another model and nothing is forced through (rule 8).
 */
export async function writeArticle(deps: WriteDeps, storeId: number, topicId: number): Promise<WriteOutcome> {
  const { db, llm } = deps
  const pack = await loadPack(db, storeId, topicId)
  const { rows } = await db.query<{ id: number }>(
    `insert into articles (store_id, topic_id, language, state) values ($1, $2, $3, 'writing')
     on conflict (topic_id) do update set state = 'writing' returning id::int`,
    [storeId, topicId, pack.language],
  )
  const articleId = rows[0]!.id
  const attempts: Attempt[] = []

  const save = async (state: string, draft: Draft | null, report: GateReport): Promise<void> => {
    const factId = new Map(pack.facts.map((f) => [f.ref, f.id]))
    const claims = draft
      ? sentences(draft.markdown)
          .filter((s) => s.facts.length || s.general)
          .map((s) => ({ sentence: s.text, facts: s.facts.map((r) => factId.get(r)).filter((id): id is number => id !== undefined), general: s.general }))
      : []
    const cited = new Set(claims.flatMap((c) => c.facts))
    const productIds = draft
      ? pack.products
          .filter((p) => draft.markdown.includes(`(${p.ref})`) || draft.markdown.includes(`{{${p.ref}}}`) || pack.facts.some((f) => f.productRef === p.ref && cited.has(f.id)))
          .map((p) => p.id)
      : []
    await db.query(
      `update articles set state = $2, title = $3, meta_description = $4, slug = $5, markdown = $6, html = $7, product_ids = $8,
              claims = $9, gate_report = $10, written_at = now()
       where id = $1`,
      [
        articleId,
        state,
        draft?.title ?? pack.topic.workingTitle,
        draft?.metaDescription ?? null,
        draft?.slug ?? null,
        draft ? finalMarkdown(draft.markdown, pack) : null,
        draft ? renderHtml(draft.markdown, pack) : null,
        productIds,
        JSON.stringify(claims),
        JSON.stringify(report),
      ],
    )
  }

  const hold = async (reason: HeldReason, problem: Problem | null): Promise<WriteOutcome> => {
    await save('held', attempts.at(-1)?.draft ?? null, { outcome: 'held', heldReason: reason, heldProblem: problem, attempts })
    await db.query(`update topics set state = 'held', held_reason = $2 where id = $1`, [topicId, reason])
    return { articleId, outcome: 'held', heldReason: reason }
  }

  if (pack.facts.length < CONFIG.minDistinctFactsPerArticle) {
    return hold('too_few_facts', { detail: `the products behind this topic hold ${pack.facts.length} facts; ${CONFIG.minDistinctFactsPerArticle} are needed` })
  }

  try {
    const context = packText(pack)
    const plan = await llm.json({
      storeId,
      prompt: { name: PLAN_PROMPT.name, version: PLAN_PROMPT.version },
      system: PLAN_PROMPT.system[pack.language],
      user: context,
      schema: planSchema,
      effort: 'medium',
      maxTokens: 8_000,
    })
    const first = toDraft(
      await llm.json({
        storeId,
        prompt: { name: DRAFT_PROMPT.name, version: DRAFT_PROMPT.version },
        system: DRAFT_PROMPT.system[pack.language],
        user: `${context}\n\n${planText(plan)}`,
        schema: draftSchema,
        effort: 'high',
        maxTokens: 20_000,
      }),
    )
    attempts.push(await attempt(llm, pack, first))
    if (!passed(attempts[0]!)) {
      const problems = failures(attempts[0]!)
      const second = toDraft(
        await llm.json({
          storeId,
          prompt: { name: REPAIR_PROMPT.name, version: REPAIR_PROMPT.version },
          system: REPAIR_PROMPT.system[pack.language],
          user: `${context}\n\n${draftText(first)}\n\n<problems>\n${problems.map((p, i) => `${i + 1}. ${p.sentence ? `"${p.sentence}" — ` : ''}${p.detail}`).join('\n')}\n</problems>`,
          schema: draftSchema,
          effort: 'high',
          maxTokens: 20_000,
        }),
      )
      attempts.push(await attempt(llm, pack, second))
    }
  } catch (error) {
    if (error instanceof MalformedOutputError) return hold('malformed', { detail: error.message })
    if (error instanceof ModelRefusedError) return hold('refused', { detail: error.message })
    throw error
  }

  const last = attempts.at(-1)!
  if (!passed(last)) {
    const { reason, problem } = heldBy(last)
    return hold(reason, problem)
  }

  const { rows: store } = await db.query<{ review_first: boolean }>(`select review_first from stores where id = $1`, [storeId])
  await save(store[0]!.review_first ? 'awaiting_review' : 'ready', last.draft, { outcome: 'passed', heldReason: null, heldProblem: null, attempts })
  await db.query(`update topics set state = 'written', held_reason = null where id = $1`, [topicId])
  return { articleId, outcome: 'passed', heldReason: null }
}
