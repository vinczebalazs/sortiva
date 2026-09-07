import { describe, expect, it } from 'vitest'
import type { LlmClient, LlmRequest, LlmResult } from '../contracts/llm'
import { distillProduct, DISTILL_NO_MODEL } from './distill'
import { countFacts, countPopulatedFields, type ExtractedFacts } from './schema'
import { descriptionText } from './text'

/**
 * A local `LlmClient` double rather than `@sortiva/llm`'s `MockLlmClient`:
 * `packages/llm` depends on `packages/core`, so importing it here would be a
 * cycle. Schema enforcement is proved on the other side of that dependency, in
 * `packages/llm/src/eval/distill-runner.test.ts`, against the real validator.
 */
class StubLlmClient implements LlmClient {
  readonly requests: LlmRequest[] = []
  constructor(private readonly answer: ExtractedFacts) {}

  async complete<T>(request: LlmRequest): Promise<LlmResult<T>> {
    this.requests.push(request)
    return {
      output: this.answer as T,
      text: JSON.stringify(this.answer),
      modelId: 'claude-haiku-4-5',
      promptVersion: request.promptVersion,
      cacheHit: false,
      usage: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      usdCost: 0.00035,
      latencyMs: 12,
      attempts: 1,
    }
  }
}

const PROMPT = { version: 'distill.v1', text: 'extract only' }

function facts(overrides: Partial<ExtractedFacts> = {}): ExtractedFacts {
  return {
    material: null,
    dimensions: null,
    weight: null,
    capacity: null,
    compatibility: [],
    use_cases_stated: [],
    care: null,
    certifications: [],
    origin: null,
    verifiable_claims: [],
    fluff_discarded: false,
    ...overrides,
  }
}

describe('distillProduct', () => {
  it('keeps the noun and merges the price we already hold', async () => {
    const llm = new StubLlmClient(
      facts({ material: 'leather', capacity: '20 L', fluff_discarded: true }),
    )

    const result = await distillProduct(
      { llm, prompt: PROMPT },
      {
        accountId: 'acc-1',
        domain: 'example.com',
        product: {
          productId: 'p1',
          title: 'Carry Tote',
          descriptionText:
            'Premium quality Italian leather tote, perfect for any occasion. Holds 20 L.',
          priceRange: { min: 89, max: 129 },
        },
      },
    )

    expect(result.factSheet.material).toBe('leather')
    expect(result.factSheet.capacity).toBe('20 L')
    expect(result.factSheet.price_range).toEqual({ min: 89, max: 129 })
    expect(result.factSheet.fact_count).toBe(2)
    expect(result.populatedFields).toBe(2)
    expect(result.modelId).toBe('claude-haiku-4-5')
    expect(result.promptVersion).toBe('distill.v1')
    expect(result.modelCalled).toBe(true)
  })

  it('sends the model the title and the description, and nothing else about the store', async () => {
    const llm = new StubLlmClient(facts({ material: 'merino wool' }))

    await distillProduct(
      { llm, prompt: PROMPT },
      {
        accountId: 'acc-1',
        product: {
          productId: 'p1',
          title: 'Base Layer',
          descriptionText: '100% merino wool base layer for cold-weather hiking, machine washable.',
          priceRange: { min: 60, max: 60 },
        },
      },
    )

    const [request] = llm.requests
    expect(request?.callType).toBe('distill')
    expect(request?.schema).toBeDefined()
    const sent = request!.messages.map((m) => m.content).join('\n')
    expect(sent).toContain('Base Layer')
    expect(sent).toContain('merino wool')
    // The price is merged from our own record; putting it in the prompt would
    // make every sale a fresh, billed call for a product whose words did not move.
    expect(sent).not.toContain('60')
  })

  it('spends nothing on a product with no usable description', async () => {
    const llm = new StubLlmClient(facts({ material: 'invented' }))

    const result = await distillProduct(
      { llm, prompt: PROMPT },
      {
        accountId: 'acc-1',
        product: {
          productId: 'p1',
          title: 'Mystery Box',
          descriptionText: 'A box.',
          priceRange: { min: 10, max: 10 },
        },
      },
    )

    expect(llm.requests).toEqual([])
    expect(result.modelCalled).toBe(false)
    expect(result.modelId).toBe(DISTILL_NO_MODEL)
    expect(result.factSheet.fact_count).toBe(0)
    expect(result.factSheet.material).toBeNull()
    // Still true of the product, and still free.
    expect(result.factSheet.price_range).toEqual({ min: 10, max: 10 })
  })

  it('treats an empty string as nothing said, and says a repeated fact once', async () => {
    const llm = new StubLlmClient(
      facts({
        material: '   ',
        use_cases_stated: ['commuting', 'Commuting', '  ', 'wet-weather hiking'],
        verifiable_claims: ['waterproof to 10 m'],
      }),
    )

    const result = await distillProduct(
      { llm, prompt: PROMPT },
      {
        accountId: 'acc-1',
        product: {
          productId: 'p1',
          title: 'Shell Jacket',
          descriptionText:
            'A shell jacket for commuting and wet-weather hiking. Waterproof to 10 m.',
          priceRange: null,
        },
      },
    )

    expect(result.factSheet.material).toBeNull()
    expect(result.factSheet.use_cases_stated).toEqual(['commuting', 'wet-weather hiking'])
    expect(result.factSheet.fact_count).toBe(3)
    // Two fields carried anything, whatever the number of entries in them.
    expect(result.populatedFields).toBe(2)
  })

  it("names the axes a product varies along from the store's own option fields", async () => {
    const llm = new StubLlmClient(facts({ material: 'mesh' }))

    const result = await distillProduct(
      { llm, prompt: PROMPT },
      {
        accountId: 'acc-1',
        product: {
          productId: 'p1',
          title: 'Trail Shoe',
          descriptionText: 'A mesh trail shoe built for long days on rough ground.',
          priceRange: { min: 120, max: 120 },
          options: [
            { name: 'Size', values: ['UK 8', 'UK 9'] },
            { name: 'Colour', values: ['Black', 'Tan'] },
          ],
        },
      },
    )

    expect(result.factSheet.variant_axes).toEqual(['Size', 'Colour'])
    // Names, not values: every value belongs to this one product, so listing
    // them would say a shoe is black and tan at once.
    expect(result.factSheet.variant_axes).not.toContain('Black')
    // The axes are merged, not extracted, so they do not count as facts the
    // description supported — otherwise every product in every store would look
    // better described than it is.
    expect(result.factSheet.fact_count).toBe(1)
    expect(result.populatedFields).toBe(1)
    // Nothing about the axes reaches the model.
    const sent = llm.requests.map((r) => r.messages.map((m) => m.content).join('\n')).join('\n')
    expect(sent).not.toContain('Colour')
  })

  it('leaves the axes empty for a store that publishes none, rather than guessing', async () => {
    const llm = new StubLlmClient(facts({ material: 'mesh' }))
    const result = await distillProduct(
      { llm, prompt: PROMPT },
      {
        accountId: 'acc-1',
        product: {
          productId: 'p1',
          title: 'Trail Shoe',
          descriptionText: 'A mesh trail shoe built for long days on rough ground.',
          priceRange: null,
          options: [{ name: 'Title', values: ['Default Title'] }],
        },
      },
    )
    expect(result.factSheet.variant_axes).toEqual([])
  })

  it('never carries the description into the fact sheet', async () => {
    const marketing = 'Effortlessly elevate your everyday carry with this stunning leather tote.'
    const llm = new StubLlmClient(facts({ material: 'leather', fluff_discarded: true }))

    const result = await distillProduct(
      { llm, prompt: PROMPT },
      {
        accountId: 'acc-1',
        product: {
          productId: 'p1',
          title: 'Tote',
          descriptionText: marketing,
          priceRange: null,
        },
      },
    )

    expect(JSON.stringify(result.factSheet)).not.toContain('Effortlessly')
    expect(result.factSheet.fluff_discarded).toBe(true)
  })
})

describe('fact counting', () => {
  it('counts every entry of a list as a fact, but the field only once', () => {
    const sheet = facts({
      material: 'steel',
      compatibility: ['iPhone 15', 'iPhone 16'],
      use_cases_stated: ['cycling'],
    })
    expect(countFacts(sheet)).toBe(4)
    expect(countPopulatedFields(sheet)).toBe(3)
  })

  it('counts nothing for a sheet that states nothing', () => {
    expect(countFacts(facts())).toBe(0)
    expect(countPopulatedFields(facts())).toBe(0)
  })
})

describe('descriptionText', () => {
  it('drops markup, resolves entities and keeps the words', () => {
    const html = '<div><p>100&#37; <b>merino</b> wool</p><script>alert(1)</script><p>Made in Portugal</p></div>'
    expect(descriptionText(html)).toBe('100% merino wool\nMade in Portugal')
  })

  it('is empty for a product with no description', () => {
    expect(descriptionText(null)).toBe('')
    expect(descriptionText('<p>  </p>')).toBe('')
  })

  it('caps a runaway description at a word boundary', () => {
    const long = `<p>${'waterproof '.repeat(2_000)}</p>`
    const text = descriptionText(long)
    expect(text.length).toBeLessThanOrEqual(6_000)
    expect(text.endsWith('waterproof')).toBe(true)
  })
})
