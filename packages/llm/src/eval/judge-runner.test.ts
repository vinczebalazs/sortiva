import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { LlmValidationFailure } from '@sortiva/core'
import { MockLlmClient } from '../mock'
import { judgeEvalRunner, type JudgeEvalInput } from './judge-runner'
import { loadEvalSet, runEvalSet, EVAL_RUNNERS, type EvalRunnerRegistry } from './runner'

/**
 * `judge.eval` itself runs on its own gate (`pnpm eval`) against the real
 * model, because grading a stand-in grades nothing.
 *
 * What runs *here*, on every merge, is everything around that model call: the
 * set loads, every case has hand-assigned gold scores, the prompt renders, the
 * schema is enforced, the MAE threshold bites, and — the one that matters most
 * — a false pass fails the set on its own rather than being averaged away.
 */

const SET_DIR = fileURLToPath(new URL('../../eval/judge.eval', import.meta.url))
const set = loadEvalSet(SET_DIR)

type GoldScores = Record<string, number | boolean>

const CRITERIA = [
  'informationGain',
  'factualGrounding',
  'searchIntentMatch',
  'actionability',
  'languageQuality',
  'ecommerceUsefulness',
] as const

function goldByKeyword(): Map<string, GoldScores> {
  const map = new Map<string, GoldScores>()
  for (const testCase of set.cases) {
    const input = testCase.input as JudgeEvalInput
    map.set(input.draft.title, testCase.gold as GoldScores)
  }
  return map
}

/** Answers each case with its own gold scores: a judge that agrees with the humans exactly. */
function perfectClient(): MockLlmClient {
  const gold = goldByKeyword()
  const client = new MockLlmClient()
  client.setDefault('judge', (request) => {
    const title = titleOf(request.messages)
    const scores = gold.get(title)
    if (!scores) throw new Error(`no gold scores for "${title}"`)
    const numeric = Object.fromEntries(CRITERIA.map((c) => [c, scores[c] as number]))
    return JSON.stringify({
      scores: numeric,
      justifications: Object.fromEntries(CRITERIA.map((c) => [c, `graded on ${c}`])),
    })
  })
  return client
}

/** The article's own H1 is the first line of the rendered draft the judge is shown. */
function titleOf(messages: readonly { content: string }[]): string {
  const match = messages[0]?.content.match(/^# (.*)$/m)
  return match?.[1] ?? ''
}

function registryFor(client: MockLlmClient): EvalRunnerRegistry {
  return { judge: judgeEvalRunner(client) }
}

describe('judge.eval, the set itself', () => {
  it('holds the ~20 drafts the frozen set calls for, each with gold scores', () => {
    expect(set.config.name).toBe('judge')
    expect(set.config.maxMae).toBe(0.5)
    expect(set.config.allowFalsePass).toBe(false)
    expect(set.cases.length).toBeGreaterThanOrEqual(20)
  })

  it('scores every criterion in every case, on the 1–5 scale', () => {
    for (const testCase of set.cases) {
      const gold = testCase.gold as GoldScores
      for (const criterion of CRITERIA) {
        expect(typeof gold[criterion], `${testCase.id}.${criterion}`).toBe('number')
        expect(gold[criterion] as number).toBeGreaterThanOrEqual(1)
        expect(gold[criterion] as number).toBeLessThanOrEqual(5)
      }
    }
  })

  it('holds drafts humans failed, or the false-pass check would have nothing to catch', () => {
    const failed = set.cases.filter((c) => (c.gold as GoldScores).passed === false)
    expect(failed.length).toBeGreaterThanOrEqual(8)
  })

  it('holds drafts humans passed, so the set is not simply "reject everything"', () => {
    const passed = set.cases.filter((c) => (c.gold as GoldScores).passed === undefined)
    expect(passed.length).toBeGreaterThanOrEqual(5)
  })

  it('grades in more than one language, because language quality cannot be judged in translation', () => {
    const locales = new Set(set.cases.map((c) => (c.input as JudgeEvalInput).pack.serp.locale))
    expect(locales.size).toBeGreaterThanOrEqual(2)
  })

  it('is registered, so the suite runs it rather than silently skipping it', () => {
    expect(Object.keys(EVAL_RUNNERS)).toContain('judge')
  })
})

describe('judge.eval, the grading', () => {
  it('passes when the judge agrees with the human scores', async () => {
    const result = await runEvalSet(set, registryFor(perfectClient()))
    expect(result.failures).toEqual([])
    expect(result.passed).toBe(true)
    expect(result.caseCount).toBe(set.cases.length)
  })

  it('fails the set on a single false pass, whatever the error looks like elsewhere', async () => {
    const gold = goldByKeyword()
    const client = new MockLlmClient()
    client.setDefault('judge', (request) => {
      const title = titleOf(request.messages)
      const scores = gold.get(title)!
      const numeric: Record<string, number> = Object.fromEntries(
        CRITERIA.map((c) => [c, scores[c] as number]),
      )
      // One draft humans failed is nudged over every floor — and nothing else
      // in the set moves at all.
      if (title === 'Best trail running shoes for wide feet') {
        for (const criterion of CRITERIA) numeric[criterion] = 4
      }
      return JSON.stringify({
        scores: numeric,
        justifications: Object.fromEntries(CRITERIA.map((c) => [c, 'ok'])),
      })
    })

    const result = await runEvalSet(set, registryFor(client))
    expect(result.passed).toBe(false)
    expect(result.failures.join('\n')).toContain('false pass')
    // The aggregate error is still tiny, which is exactly why the false pass is
    // checked per case rather than read off the average.
    expect(result.mae!.overall).toBeLessThan(0.5)
  })

  it('fails the set when the judge drifts a point away from the human grades', async () => {
    const gold = goldByKeyword()
    const client = new MockLlmClient()
    client.setDefault('judge', (request) => {
      const scores = gold.get(titleOf(request.messages))!
      return JSON.stringify({
        scores: Object.fromEntries(CRITERIA.map((c) => [c, Math.min(5, (scores[c] as number) + 1)])),
        justifications: Object.fromEntries(CRITERIA.map((c) => [c, 'ok'])),
      })
    })

    const result = await runEvalSet(set, registryFor(client))
    expect(result.passed).toBe(false)
    expect(result.failures.join('\n')).toMatch(/MAE .* exceeds 0\.5/)
  })

  it('refuses a verdict that does not fit the judging contract', async () => {
    const client = new MockLlmClient()
    // Scores off the scale, and a criterion the gate would have no floor for.
    client.setDefault('judge', () => JSON.stringify({ scores: { informationGain: 9 }, justifications: {} }))

    await expect(judgeEvalRunner(client)(set.cases[0]!.input, set.config)).rejects.toBeInstanceOf(
      LlmValidationFailure,
    )
    // One repair attempt, then it stops.
    expect(client.countOf('judge')).toBe(2)
  })

  it('sends the versioned prompt and runs on the judge tier, never a cheaper one', async () => {
    const client = perfectClient()
    await judgeEvalRunner(client)(set.cases[0]!.input, set.config)
    expect(client.calls[0]?.promptVersion).toBe('judge.v1')
    expect(client.calls[0]?.modelId).toBe('claude-sonnet-5')
  })
})
