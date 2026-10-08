import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { possibleOverlaps } from '../../core/topics/check.ts'
import { topicContext } from '../../core/topics/discover.ts'
import { judgeOverlaps } from '../../core/topics/overlap.ts'
import { startPipeline, type Pipeline } from '../pipeline.ts'

let p: Pipeline
beforeAll(async () => {
  p = await startPipeline()
})
afterAll(() => p?.stop())

// Each case: a planned article's searches, and the existing post that already answers it, or null.
const CASES = {
  'blog-en': [
    [['choosing a harness for your dog', 'best dog harness'], 'How to choose a dog harness'],
    [['how to clean a dog leash', 'wash dog lead'], null],
    [['what length dog leash', 'dog leash length'], 'Dog leash length guide: 4 ft, 6 ft or long line?'],
    [['dog blanket vs dog bed', 'do dogs need a bed'], null],
    [['how to measure a dog for a harness', 'dog harness size'], 'Harness size guide'],
  ],
  'blog-hu': [
    [['kerékpárlámpa választás', 'milyen bicikli lámpát vegyek'], 'Hogyan válassz kerékpárlámpát?'],
    [['kerékpárlámpa akkumulátor üzemidő', 'meddig bírja a bicikli lámpa'], null],
    [['melyik zár a legbiztonságosabb', 'u lakat vagy lánc'], 'U-lakat vagy láncos zár: melyik a biztonságosabb?'],
    [['kerékpárcsengő felszerelése', 'bicikli csengő'], null],
    [['kötelező kerékpár felszerelések', 'mi kell a biciklire kresz'], 'Mi kötelező a kerékpáron?'],
  ],
} as const

describe.each(Object.keys(CASES) as (keyof typeof CASES)[])('%s: the model decides whether an existing post already answers a planned article', (name) => {
  it('agrees with the expected answer for every case, and only names posts the word check offered', async () => {
    const store = await p.install(name)
    await p.settle()
    await p.completeSetup(store.id)
    await p.settle()
    const ctx = (await topicContext(p.db.pool, store.id))!
    const language = name.endsWith('-hu') ? 'hu' : 'en'
    const questions = CASES[name].map(([phrasings]) => ({
      phrasings: [...phrasings],
      workingTitle: phrasings[0],
      candidates: possibleOverlaps([...phrasings], language, ctx.pages, ctx.storeWords),
    }))
    const verdicts = await judgeOverlaps(p.deps.llm, store.id, language, questions)
    expect(verdicts.map((v, i) => [CASES[name][i]![0][0], v?.title ?? null])).toEqual(CASES[name].map(([q, expected]) => [q[0], expected]))
  })
})
