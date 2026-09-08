import { describe, expect, it } from 'vitest'
import { rules } from '@sortiva/rules'
import { EXTRACTED_FIELDS, type FactSheet } from '../../distill/schema'
import { deterministicMerchantClaims } from '../../generation/claims'
import { buildDraftRequest, type CitableProduct } from '../../generation/draft'
import type { EvidencePack } from '../../generation/evidence-pack'
import { lengthTargetFor } from '../../generation/length'
import type { ProductField } from '../../signals/substance'
import { buildJudgeRequest } from './judge'
import { buildRepairRequest } from './repair'
import { fixturePack, fixturePlan, passingDraft } from './testing'

/**
 * The writing prompt and the judge's evidence are assembled in two different
 * files, and for a while nothing compared them. The judge was rendered every
 * non-empty fact-sheet field while the writer got approved claims built from
 * the ten fields a description can support, so the judge could confirm a claim
 * — a price, most dangerously — against a figure that was never in front of
 * the model that wrote it.
 *
 * These tests hold both halves of the rule, and they pull in opposite
 * directions on purpose:
 *
 * - the judge is never shown a value the writer was not shown, or grounding
 *   stops meaning anything;
 * - the judge is still shown *less*, which is what keeps it a separate
 *   judgement rather than a re-run of the writing call.
 *
 * The first is written against values rather than field names, so it catches a
 * leak through any route — a new key, a nested object, a field added to the
 * fact sheet next month — not just the one that caused it.
 */

const config = rules().defaults

/** Fact-sheet fields no claim is built from, and so no grading may rest on either. */
type WithheldField = Exclude<keyof FactSheet, ProductField>

/**
 * A distinctive value for every withheld field. The mapped type is the point:
 * a new field on the fact sheet that is not one the claim plan reads fails to
 * compile here until somebody gives it a sentinel, rather than slipping through
 * untested.
 */
const WITHHELD: { readonly [K in WithheldField]: FactSheet[K] } = {
  variant_axes: ['Sentinel axis Wingspan'],
  price_range: { min: 1290.11, max: 2490.22 },
  fluff_discarded: true,
  fact_count: 987654,
}

interface Leaf {
  readonly path: string
  readonly value: string
}

/** Every primitive that survives serialisation, with the route it arrived by. */
function leaves(value: unknown, path = ''): Leaf[] {
  if (Array.isArray(value)) return value.flatMap((item, i) => leaves(item, `${path}[${i}]`))
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, child]) =>
      leaves(child, path === '' ? key : `${path}.${key}`),
    )
  }
  if (value === null || value === undefined) return []
  return [{ path, value: String(value) }]
}

const WITHHELD_SENTINELS = leaves(WITHHELD)
  .map((leaf) => leaf.value)
  // `true` is not distinctive enough to search a prompt for; the field name is
  // asserted separately below, because a boolean has no value worth hunting.
  .filter((value) => value !== 'true' && value !== 'false')

/**
 * A pack where every withheld field carries its sentinel, and where the family
 * is named and differs along an axis that appears nowhere else — so a judge
 * block that starts describing families again fails on the words rather than on
 * a field name somebody could rename.
 */
function packWithEveryWithheldFieldFilled(): EvidencePack {
  const base = fixturePack()
  return {
    ...base,
    families: base.families.map((family) => ({
      ...family,
      name: 'Sentinel family Fettle',
      differentiationAxes: ['Sentinel family axis Girth'],
    })),
    products: base.products.map((product) => ({
      ...product,
      factSheet: { ...product.factSheet, ...WITHHELD },
    })),
  }
}

/** The products the writer may name, derived as the generation job derives them. */
function citableProductsFor(pack: EvidencePack): CitableProduct[] {
  const ids = new Set<string>()
  for (const claim of deterministicMerchantClaims(pack)) {
    for (const ref of claim.evidence) if (ref.kind === 'product') ids.add(ref.productId)
  }
  return pack.products
    .filter((product) => ids.has(product.productId))
    .map((product, i) => ({ id: `p${i + 1}`, productId: product.productId, title: product.title }))
}

/** Everything the writing model is actually sent, as one string to search. */
function writerPrompt(pack: EvidencePack): string {
  const request = buildDraftRequest(draftInputFor(pack))
  return [request.system ?? '', ...request.messages.map((message) => message.content)].join('\n')
}

const WRITER_PROMPT = { version: 'draft.v1', text: 'You write one ecommerce article from a closed set of approved claims.' }
const JUDGE_PROMPT = { version: 'judge.v1', text: 'You grade one finished ecommerce article.' }

function draftInputFor(pack: EvidencePack) {
  return {
    prompt: WRITER_PROMPT,
    accountId: 'a1',
    targetKeyword: 'hiking backpacks',
    // The shape whose sections *do* expand per axis, so the writer is shown as
    // much as any shape ever shows it. Anything the judge holds that is still
    // missing here is missing from every shape.
    shape: 'buying_guide' as const,
    axes: pack.families.flatMap((family) => family.differentiationAxes),
    claims: fixturePlan(pack).claims,
    citableProducts: citableProductsFor(pack),
    length: lengthTargetFor(pack.serp, config.generation.length),
    internalLinks: [{ url: 'https://store.example/pages/fitting-guide', reason: 'existing_target_weak_match' as const }],
  }
}

/** Everything the judging model is actually sent, as one string to search. */
function judgeText(pack: EvidencePack): string {
  const request = buildJudgeRequest({
    prompt: JUDGE_PROMPT,
    accountId: 'a1',
    targetKeyword: 'hiking backpacks',
    draft: passingDraft(fixturePlan(pack)),
    pack,
  })
  return [request.system ?? '', ...request.messages.map((message) => message.content)].join('\n')
}

/**
 * The store-facts section of the judge's message, taken back apart into the
 * pieces it was built from: one entry per product, one field/value pair per
 * fact. Read off the rendered call rather than off the list behind it, so a
 * value smuggled straight into the rendering is caught too.
 */
function storeFactsShownToTheJudge(pack: EvidencePack): Leaf[] {
  const rendered = judgeText(pack)
  const start = rendered.indexOf('--- What the store actually knows ---')
  const end = rendered.indexOf('--- What already ranks ---')
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)

  const out: Leaf[] = []
  for (const line of rendered.slice(start, end).split('\n')) {
    if (!line.startsWith('- ')) continue
    const [title, facts] = line.slice(2).split(' — ')
    expect(facts).toBeDefined()
    out.push({ path: 'product', value: title! })
    for (const pair of facts!.split(' | ')) {
      const marker = pair.indexOf(': ')
      // A fact rendered as anything but `<field>: <value>` is a shape this
      // check cannot read, which means it is a shape nobody has thought about.
      expect(marker).toBeGreaterThan(0)
      out.push({ path: pair.slice(0, marker), value: pair.slice(marker + 2) })
    }
  }
  return out
}

describe('the article writer and the judge see the same store facts', () => {
  it('shows the judge no value the writer was not shown', () => {
    const pack = packWithEveryWithheldFieldFilled()
    const prompt = writerPrompt(pack)
    const shown = storeFactsShownToTheJudge(pack)

    // Guards against the check passing because the judge was handed nothing.
    expect(shown.length).toBeGreaterThan(10)

    const unseenByTheWriter = shown.filter((leaf) => !prompt.includes(leaf.value))
    expect(unseenByTheWriter).toEqual([])

    // And every fact is one of the ten fields a description can support, so a
    // field the claim plan never reads cannot arrive here under a value that
    // happens to appear in the prompt for another reason.
    const fields = shown.filter((leaf) => leaf.path !== 'product').map((leaf) => leaf.path)
    expect(fields.length).toBeGreaterThan(0)
    expect(fields.filter((field) => !EXTRACTED_FIELDS.includes(field as ProductField))).toEqual([])
  })

  it('keeps the price range, the option axes and the fact count out of the judge call', () => {
    const rendered = judgeText(packWithEveryWithheldFieldFilled())

    expect(WITHHELD_SENTINELS.length).toBeGreaterThan(0)
    for (const sentinel of WITHHELD_SENTINELS) {
      expect(rendered).not.toContain(sentinel)
    }
    // The distillation flag is a boolean, so there is no value to search for.
    expect(rendered).not.toContain('fluff_discarded')
  })

  it('does not name the family or the axes it differs by', () => {
    const rendered = judgeText(packWithEveryWithheldFieldFilled())

    expect(rendered).not.toContain('Sentinel family Fettle')
    expect(rendered).not.toContain('Sentinel family axis Girth')
  })

  it('still gives the judge the store facts a claim could rest on', () => {
    const rendered = judgeText(fixturePack())

    expect(rendered).toContain('The Alpha')
    expect(rendered).toContain('material: ripstop nylon')
    expect(rendered).toContain('capacity: 35 litres')
    expect(rendered).toContain('origin: Vietnam')
  })

  it("still withholds the writer's own context, which is what keeps the grading separate", () => {
    const pack = fixturePack()
    const rendered = judgeText(pack)

    expect(rendered).not.toContain('Approved claims')
    expect(rendered).not.toContain(WRITER_PROMPT.text)
    expect(rendered).not.toContain('Target length')
    expect(rendered).not.toContain('https://store.example/pages/fitting-guide')
    expect(rendered).not.toContain('confidence]')

    const repair = buildRepairRequest({
      draftInput: draftInputFor(pack),
      revisePrompt: { version: 'revise.v1', text: 'You are revising an article you already wrote.' },
      previousDraft: passingDraft(fixturePlan(pack)),
      instructions: 'Fix actionability.',
    })
    expect(repair.messages.map((m) => m.content).join('\n')).toContain('Fix actionability.')
    expect(rendered).not.toContain('Fix actionability.')
  })
})
