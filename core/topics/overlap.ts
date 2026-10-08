import { z } from 'zod'
import type { Language } from '../config.ts'
import type { Llm } from '../llm.ts'
import type { StorePage } from './check.ts'

export const OVERLAP_PROMPT = {
  name: 'judge-overlap',
  version: '1',
  system: {
    en: `An online shop plans new blog articles. For each planned article you see the searches it targets and some of the shop's existing posts and pages, each with its title and opening text. Decide whether one of those existing posts or pages already answers what a person making those searches wants to know.

Covered means a reader of the existing post would not need the new article: same question, same purpose. Sharing a product or a subject is not enough. "How to clean a dog leash" is not covered by a post on choosing leash length; "choosing a harness for your dog" is covered by "How to choose a dog harness".

For each planned article answer with its reference (T1, T2…) and covered_by: the reference of the existing post or page that covers it (A1, A2…), or null if none does.`,
    hu: `Egy webáruház új blogcikkeket tervez. Minden tervezett cikknél látod, milyen keresésekre szól, és a bolt néhány meglévő bejegyzését vagy oldalát a címével és a kezdő szövegével. Döntsd el, hogy valamelyik meglévő bejegyzés vagy oldal már megválaszolja-e azt, amit az ilyen keresést indító ember tudni szeretne.

Lefedett az a cikk, amelyre a meglévő bejegyzés olvasójának már nincs szüksége: ugyanaz a kérdés, ugyanaz a cél. Az, hogy ugyanarról a termékről vagy témáról szólnak, még nem elég. A „kerékpárlámpa akkumulátor üzemideje” nem lefedett egy lámpaválasztásról szóló bejegyzéssel; a „kerékpárlámpa választás” lefedett a „Hogyan válassz kerékpárlámpát?” bejegyzéssel.

Minden tervezett cikkre add meg a hivatkozását (T1, T2…) és a covered_by mezőt: annak a meglévő bejegyzésnek vagy oldalnak a hivatkozását (A1, A2…), amely lefedi, vagy null-t, ha egyik sem.`,
  } satisfies Record<Language, string>,
}

const overlapSchema = z.object({ verdicts: z.array(z.object({ topic: z.string(), covered_by: z.string().nullable() })) })

export type OverlapQuestion = { phrasings: string[]; workingTitle: string; candidates: StorePage[] }

/**
 * The final word on whether an existing post already answers a planned article. Only topics the
 * word check flagged are asked about, all in one call. A verdict naming a page that was not offered
 * for that topic is ignored, so the model can only point at pages that exist.
 */
export async function judgeOverlaps(llm: Llm, storeId: number, language: Language, questions: OverlapQuestion[]): Promise<(StorePage | null)[]> {
  if (!questions.some((q) => q.candidates.length)) return questions.map(() => null)
  const pages = [...new Map(questions.flatMap((q) => q.candidates).map((p) => [p.url, p])).values()]
  const refs = new Map(pages.map((p, i) => [p.url, `A${i + 1}`]))
  const ref = (p: StorePage) => refs.get(p.url)!
  const user = [
    `<existing>\n${pages.map((p) => `${ref(p)}: ${p.title}\n${p.excerpt ? `   ${p.excerpt.slice(0, 600)}` : ''}`).join('\n')}\n</existing>`,
    `<planned>\n${questions
      .map((q, i) => (q.candidates.length ? `T${i + 1}: ${q.workingTitle}\n   searches: ${q.phrasings.join(' | ')}\n   compare with: ${q.candidates.map(ref).join(', ')}` : ''))
      .filter(Boolean)
      .join('\n')}\n</planned>`,
  ].join('\n\n')
  const answer = await llm.json({
    storeId,
    prompt: { name: OVERLAP_PROMPT.name, version: OVERLAP_PROMPT.version },
    system: OVERLAP_PROMPT.system[language],
    user,
    schema: overlapSchema,
    effort: 'low',
    maxTokens: 4_000,
  })
  const verdict = new Map(answer.verdicts.map((v) => [v.topic.trim().toUpperCase(), v.covered_by?.trim().toUpperCase() ?? null]))
  return questions.map((q, i) => {
    const named = verdict.get(`T${i + 1}`)
    return q.candidates.find((p) => ref(p) === named) ?? null
  })
}
