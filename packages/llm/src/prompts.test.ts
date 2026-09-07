import { describe, expect, it } from 'vitest'
import { loadPrompt, renderPrompt, type Prompt } from './prompts'
import { MODELS, resolveModel, resolveModelForCallType, usdCost } from './models'
import { extractJson, validateCompletion } from './validate'
import { MockLlmClient } from './mock'
import { accountAttribution } from '@sortiva/core'

/** Versioned prompts, pinned model ids, schema validation. */

const prompt: Prompt = {
  version: 'distill.v1',
  name: 'distill',
  majorVersion: 1,
  text: 'Extract facts for {{title}} in {{language}}.',
}

describe('prompts', () => {
  it('substitutes placeholders', () => {
    expect(renderPrompt(prompt, { title: 'Trail Shoe', language: 'da' })).toBe(
      'Extract facts for Trail Shoe in da.',
    )
  })

  it('refuses to render an unfilled placeholder rather than emptying it', () => {
    expect(() => renderPrompt(prompt, { title: 'Trail Shoe' })).toThrow(/unfilled placeholders: language/)
  })

  it('points at the versioning rule when a prompt file is missing', () => {
    expect(() => loadPrompt('nonexistent', 1)).toThrow(/versioned files/)
  })
})

describe('model registry', () => {
  it('pins explicit ids per tier (main §14.2 — never a "latest" alias)', () => {
    expect(resolveModel('haiku', {}).id).toBe(MODELS.haiku.id)
    expect(resolveModel('sonnet', {}).id).toBe(MODELS.sonnet.id)
  })

  it('accepts an explicit env override but rejects an alias', () => {
    expect(resolveModel('sonnet', { ANTHROPIC_MODEL_SONNET: 'claude-sonnet-4-6' }).id).toBe(
      'claude-sonnet-4-6',
    )
    expect(() => resolveModel('sonnet', { ANTHROPIC_MODEL_SONNET: 'claude-sonnet-latest' })).toThrow(
      /alias/,
    )
  })

  it('pins the judge in code, so no environment can point it at the cheap model', () => {
    // What an operator would set to move the strong tier wholesale.
    const env = { ANTHROPIC_MODEL_SONNET: MODELS.haiku.id, ANTHROPIC_MODEL_HAIKU: 'claude-haiku-4-4' }

    expect(resolveModelForCallType('judge', env).id).toBe(MODELS.sonnet.id)
    // Everything else still follows the variable for its tier.
    expect(resolveModelForCallType('draft', env).id).toBe(MODELS.haiku.id)
    expect(resolveModelForCallType('distill', env).id).toBe('claude-haiku-4-4')
  })

  it('prices a call at six decimals, so a fraction of a cent is not reported as zero', () => {
    expect(usdCost(MODELS.haiku, 1000, 200)).toBeCloseTo(0.002, 6)
    expect(usdCost(MODELS.haiku, 10, 1)).toBeGreaterThan(0)
  })
})

describe('validation', () => {
  it('unwraps a fenced JSON block but still parses strictly', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ ok: true, value: { a: 1 } })
    expect(extractJson('{"a":').ok).toBe(false)
  })

  it('reports every schema violation, not just the first', () => {
    const outcome = validateCompletion('{"a":"x"}', {
      type: 'object',
      required: ['b'],
      properties: { a: { type: 'number' }, b: { type: 'string' } },
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.errors.length).toBeGreaterThan(1)
  })

  it('passes text through untouched when no schema is supplied', () => {
    expect(validateCompletion('a plain sentence', undefined)).toEqual({
      ok: true,
      value: 'a plain sentence',
    })
  })
})

describe('MockLlmClient', () => {
  it('accounts cost per call, so a pipeline test can assert spend', async () => {
    const mock = new MockLlmClient().setDefault('persona', '{"language":"da"}')
    const request = {
      callType: 'persona' as const,
      promptVersion: 'persona.v1',
      messages: [{ role: 'user' as const, content: 'x'.repeat(4000) }],
      maxTokens: 512,
      schema: { type: 'object', required: ['language'] },
      attribution: accountAttribution('acc-1', 'example.com'),
    }

    await mock.complete(request)
    await mock.complete(request)

    expect(mock.countOf('persona')).toBe(2)
    expect(mock.totalUsdCost).toBeGreaterThan(0)
    expect(mock.calls[0]!.usdCost).toBeCloseTo(mock.calls[1]!.usdCost, 9)
  })

  it('enforces the schema, so a bad fixture fails like production would', async () => {
    const mock = new MockLlmClient().setDefault('judge', '{"unexpected":true}')
    await expect(
      mock.complete({
        callType: 'judge',
        promptVersion: 'judge.v2',
        messages: [{ role: 'user', content: 'grade this' }],
        maxTokens: 256,
        schema: { type: 'object', required: ['information_gain'] },
        attribution: accountAttribution('acc-1'),
      }),
    ).rejects.toThrow(/failed schema validation/)
  })

  it('names the call type when nothing is scripted', async () => {
    const mock = new MockLlmClient()
    await expect(
      mock.complete({
        callType: 'seeds',
        promptVersion: 'seeds.v1',
        messages: [{ role: 'user', content: 'x' }],
        maxTokens: 128,
        attribution: accountAttribution('acc-1'),
      }),
    ).rejects.toThrow(/no response for call_type "seeds"/)
  })
})
