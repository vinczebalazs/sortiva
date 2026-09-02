import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { InMemoryRequestCache, type StoreConnection } from '@sortiva/core'
import { accountScope, productFactsForAccount, upsertProducts } from '@sortiva/db'
import {
  databaseAvailable,
  insertAccount,
  setupTestDb,
  truncateAll,
  type TestDb,
} from '@sortiva/db/testing'
import { MockLlmClient } from '@sortiva/llm'
import { deriveIdempotencyKey } from '../runtime/idempotency'
import { runStep } from '../runtime/runStep'
import { createRun, findStep, getStep } from '../runtime/steps'
import type { ConnectionStore, IngestionDeps } from './deps'
import { distillStep, type DistillCheckpoint, type DistillOutput } from './distill'

/**
 * Distillation against a real database and the model wrapper's own test double,
 * which accounts cost the way the live client does — so "did this run pay
 * twice" is a number the test can assert rather than a claim.
 *
 * The card's headline check is here: **a product nobody edited is not distilled
 * again**. It is proved by running the step over a catalogue, editing exactly
 * one product's words, running it again, and asserting that one model call was
 * made and the rest were recognised as already done.
 */

let harness: TestDb
let accountId: string

const PROMPT = { version: 'distill.v1', text: 'extract only, never infer' }

/** A fact sheet the schema accepts, with the material taken from the product's own words. */
function sheetFor(title: string): string {
  return JSON.stringify({
    material: title.includes('Tote') ? 'leather' : 'merino wool',
    dimensions: null,
    weight: null,
    capacity: '20 L',
    compatibility: [],
    use_cases_stated: ['commuting'],
    care: null,
    certifications: [],
    origin: null,
    verifiable_claims: [],
    fluff_discarded: true,
  })
}

function mockLlm(cache = new InMemoryRequestCache()): MockLlmClient {
  const client = new MockLlmClient({ cache })
  client.setDefault('distill', (request) => {
    const title = request.messages[0]?.content.match(/^Product title: (.*)$/m)?.[1] ?? ''
    return sheetFor(title)
  })
  return client
}

class FakeConnections implements ConnectionStore {
  private connection: StoreConnection

  constructor(accountIdValue: string) {
    this.connection = {
      accountId: accountIdValue,
      shopHandle: 'acme',
      grantedScopes: ['read_products'],
      connectedAt: new Date('2026-09-01T09:00:00Z'),
      invalidatedAt: null,
    }
  }

  async read(): Promise<StoreConnection | undefined> {
    return this.connection
  }

  async readToken(): Promise<string | undefined> {
    return 'shpat_test'
  }

  async markInvalid(_accountId: string, at: Date): Promise<Date> {
    return at
  }
}

function deps(llm?: MockLlmClient): IngestionDeps {
  return {
    db: harness.db,
    pool: harness.pool,
    fetcher: { async fetch() { throw new Error('distillation makes no page fetches') } },
    shopify: {
      authorizeUrl: () => '',
      verifyCallbackSignature: () => true,
      exchangeCode: async () => ({ accessToken: '', grantedScopes: [] }),
      revokeAccess: async () => {},
    },
    shop: { async getShop() { throw new Error('not used') } },
    connections: new FakeConnections(accountId),
    domains: {
      async findAccountByShopHandle() { return accountId },
      async setPlatform() {},
      async transition() { return undefined },
      async read() { return 'ingesting' },
      async readNormalized() { return 'acme.example' },
    },
    ...(llm ? { llm, distillPrompt: PROMPT } : {}),
  }
}

/**
 * One product, written the way the catalogue sync writes it — through the same
 * repository, so the description is compressed by the same code that compresses
 * it in production and read back through the same accessor.
 */
async function insertProduct(input: {
  shopifyId: string
  title: string
  bodyHtml: string | null
  checksum: string
  updatedAt?: string
}): Promise<void> {
  await upsertProducts(harness.db, accountScope(accountId), [
    {
      shopifyProductId: input.shopifyId,
      title: input.title,
      rawBodyHtml: input.bodyHtml,
      productType: null,
      tags: [],
      variants: [],
      priceRange: { min: 89, max: 129 },
      updatedAt: new Date(input.updatedAt ?? '2026-06-14T10:00:00Z'),
      checksum: input.checksum,
    },
  ])
}

async function runDistill(world: IngestionDeps, on?: { jobId: string; stepId: string }) {
  let target = on
  if (!target) {
    const run = await createRun(harness.db, accountId, `run-${Date.now()}-${Math.random()}`)
    await harness.pool.query(
      `update job_steps set state = 'succeeded' where job_id = $1 and step in ('detect','oauth_wait','catalog_sync')`,
      [run.jobId],
    )
    const step = await findStep(harness.db, run.jobId, 'distill')
    target = { jobId: run.jobId, stepId: step!.id }
  }
  await harness.pool.query(`update job_steps set next_attempt_at = null where id = $1`, [
    target.stepId,
  ])
  const key = deriveIdempotencyKey(
    accountId,
    'distill',
    await distillStep.inputVersion(world, accountId),
  )
  const outcome = await runStep<DistillCheckpoint>({
    db: harness.db,
    pool: harness.pool,
    accountId,
    jobId: target.jobId,
    stepId: target.stepId,
    idempotencyKey: key,
    handler: (ctx) => distillStep.execute(world, ctx),
  })
  return { outcome, ...target }
}

const available = await databaseAvailable()

describe.skipIf(!available)('turning a catalogue into fact sheets', () => {
  beforeAll(async () => {
    harness = await setupTestDb('distill')
  }, 60_000)

  afterAll(async () => {
    await harness?.close()
  })

  beforeEach(async () => {
    await truncateAll(harness.pool)
    accountId = await insertAccount(harness.pool, `distill-${Date.now()}@example.com`)
    await harness.pool.query(
      `insert into domains (account_id, domain_normalized, platform, state)
       values ($1, 'acme.example', 'shopify', 'ingesting')`,
      [accountId],
    )
  })

  it('writes a fact sheet per product, stamped with the prompt and the model', async () => {
    await insertProduct({
      shopifyId: '1',
      title: 'Marlow Leather Tote',
      bodyHtml:
        '<p>Effortlessly elevate your everyday carry. Premium full-grain leather. Holds 20 L. Perfect for commuting.</p>',
      checksum: 'c1',
    })

    const llm = mockLlm()
    const { outcome } = await runDistill(deps(llm))

    expect(outcome.status).toBe('succeeded')
    const sheets = await productFactsForAccount(harness.db, accountScope(accountId))
    expect(sheets).toHaveLength(1)
    expect(sheets[0]?.factSheet.material).toBe('leather')
    expect(sheets[0]?.factSheet.price_range).toEqual({ min: 89, max: 129 })
    expect(sheets[0]?.factCount).toBe(3)
    expect(sheets[0]?.fluffDiscarded).toBe(true)

    const { rows } = await harness.pool.query<{ prompt_version: string; model_id: string }>(
      'select prompt_version, model_id from product_facts',
    )
    expect(rows[0]).toEqual({ prompt_version: 'distill.v1', model_id: 'claude-haiku-4-5' })
  })

  it('keeps the merchant’s own words out of everything it writes', async () => {
    await insertProduct({
      shopifyId: '1',
      title: 'Marlow Leather Tote',
      bodyHtml: '<p>Effortlessly elevate your everyday carry with this stunning piece.</p>',
      checksum: 'c1',
    })

    await runDistill(deps(mockLlm()))

    const sheets = await productFactsForAccount(harness.db, accountScope(accountId))
    expect(JSON.stringify(sheets[0]?.factSheet)).not.toContain('Effortlessly')
    // The description is still there, still compressed, still only reachable
    // through the catalogue repository's own accessor.
    const { rows } = await harness.pool.query<{ present: boolean }>(
      'select raw_body_html is not null as present from products',
    )
    expect(rows[0]?.present).toBe(true)
  })

  it('does not distil a product nobody edited', async () => {
    await insertProduct({ shopifyId: '1', title: 'Tote One', bodyHtml: longDescription('one'), checksum: 'c1' })
    await insertProduct({ shopifyId: '2', title: 'Tote Two', bodyHtml: longDescription('two'), checksum: 'c2' })
    await insertProduct({ shopifyId: '3', title: 'Base Layer', bodyHtml: longDescription('three'), checksum: 'c3' })

    const llm = mockLlm()
    const first = await runDistill(deps(llm))
    expect(first.outcome.status).toBe('succeeded')
    expect(llm.countOf('distill')).toBe(3)
    const spentOnce = llm.totalUsdCost
    expect(spentOnce).toBeGreaterThan(0)

    // One product's words change: a rewritten description, a new checksum and a
    // later edit stamp — exactly what the catalogue sync writes when a merchant
    // edits a product.
    await insertProduct({
      shopifyId: '2',
      title: 'Tote Two',
      bodyHtml: '<p>Rewritten. Now 100% recycled canvas, 25 L, made in Portugal, ideal for cycling.</p>',
      checksum: 'c2-edited',
      updatedAt: '2026-06-20T10:00:00Z',
    })

    const second = await runDistill(deps(llm))
    expect(second.outcome.status).toBe('succeeded')

    // One call for the edited product. The other two were recognised as work
    // already done, so nothing was read, sent or paid for.
    expect(llm.countOf('distill')).toBe(4)
    const output = second.outcome.status === 'succeeded' ? (second.outcome.output as DistillOutput) : undefined
    expect(output?.productsDistilled).toBe(1)
    expect(output?.productsReplayed).toBe(2)
    expect(output?.modelCalls).toBe(1)
    expect(llm.totalUsdCost).toBeGreaterThan(spentOnce)
    // One product's worth more, not four.
    expect(llm.totalUsdCost).toBeLessThan(spentOnce * 1.5)
    expect(llm.calls.at(-1)?.cacheHit).toBe(false)
  })

  it('returns the stored answer when the same catalogue is dispatched again', async () => {
    await insertProduct({ shopifyId: '1', title: 'Tote One', bodyHtml: longDescription('one'), checksum: 'c1' })

    const llm = mockLlm()
    await runDistill(deps(llm))
    expect(llm.countOf('distill')).toBe(1)

    // A redelivered dispatch of finished work: nothing about the catalogue
    // moved, so the step's own key is the same one the ledger already holds.
    const again = await runDistill(deps(llm))
    expect(again.outcome.status).toBe('succeeded')
    expect(again.outcome.status === 'succeeded' && again.outcome.executed).toBe(false)
    expect(llm.countOf('distill')).toBe(1)
  })

  it('replays the stored completion when a crash loses the record of the work', async () => {
    await insertProduct({ shopifyId: '1', title: 'Tote One', bodyHtml: longDescription('one'), checksum: 'c1' })
    await insertProduct({ shopifyId: '2', title: 'Tote Two', bodyHtml: longDescription('two'), checksum: 'c2' })

    // The request cache survives the crash, exactly as the `request_cache`
    // table does; the model wrapper writes to it *before* the answer is
    // processed, which is what makes this safe.
    const cache = new InMemoryRequestCache()
    const llm = mockLlm(cache)
    await runDistill(deps(llm))
    const paid = llm.totalUsdCost
    expect(paid).toBeGreaterThan(0)

    // A crash after the vendor answered, before anything recorded that the work
    // was finished: the ledger is emptied and the step is offered again.
    await harness.pool.query('delete from idempotency_ledger')
    const second = await runDistill(deps(llm))

    expect(second.outcome.status).toBe('succeeded')
    // Both products were sent to the client again — and both came back from the
    // cache, so the retry cost nothing.
    expect(llm.countOf('distill')).toBe(4)
    expect(llm.calls.slice(2).every((call) => call.cacheHit)).toBe(true)
    expect(llm.totalUsdCost).toBe(paid)
  })

  it('spends nothing on a product whose page says nothing', async () => {
    await insertProduct({ shopifyId: '1', title: 'Gift Card', bodyHtml: '<p>A card.</p>', checksum: 'c1' })
    await insertProduct({ shopifyId: '2', title: 'Mystery Box', bodyHtml: null, checksum: 'c2' })

    const llm = mockLlm()
    const { outcome } = await runDistill(deps(llm))

    expect(llm.countOf('distill')).toBe(0)
    expect(llm.totalUsdCost).toBe(0)
    const sheets = await productFactsForAccount(harness.db, accountScope(accountId))
    // Both still get a sheet: "this page states nothing" is a fact about the
    // store, and it is the one the richness score is built to notice.
    expect(sheets).toHaveLength(2)
    expect(sheets.every((sheet) => sheet.factCount === 0)).toBe(true)
    const output = outcome.status === 'succeeded' ? (outcome.output as DistillOutput) : undefined
    expect(output?.richness.band).toBe('sparse')
    expect(output?.richness.productsMissingDetails).toBe(2)
  })

  it('reports how much this store’s pages actually say', async () => {
    for (const id of ['1', '2', '3']) {
      await insertProduct({
        shopifyId: id,
        title: `Tote ${id}`,
        bodyHtml: longDescription(id),
        checksum: `c${id}`,
      })
    }

    const { outcome } = await runDistill(deps(mockLlm()))
    const output = outcome.status === 'succeeded' ? (outcome.output as DistillOutput) : undefined

    expect(output?.richness.productsScored).toBe(3)
    // Three fields populated per product, against a floor of four.
    expect(output?.richness.medianPopulatedFields).toBe(3)
    expect(output?.richness.band).toBe('sparse')
    expect(output?.richness.productsMissingDetails).toBe(3)
  })

  it('resumes at the product it reached rather than at the first one', async () => {
    for (const id of ['1', '2', '3', '4']) {
      await insertProduct({
        shopifyId: id,
        title: `Tote ${id}`,
        bodyHtml: longDescription(id),
        checksum: `c${id}`,
      })
    }

    // A client that dies part-way through the catalogue.
    const llm = mockLlm()
    let seen = 0
    llm.setDefault('distill', (request) => {
      seen += 1
      if (seen === 3) throw new Error('the worker died mid-catalogue')
      const title = request.messages[0]?.content.match(/^Product title: (.*)$/m)?.[1] ?? ''
      return sheetFor(title)
    })

    const first = await runDistill(deps(llm))
    expect(first.outcome.status).toBe('retry_scheduled')
    const checkpoint = (await getStep(harness.db, first.stepId))?.checkpoint as DistillCheckpoint | null
    // The batch that died committed nothing, but the ledger holds what finished
    // inside it — which is what the resumed run reads.
    expect(checkpoint ?? null).toBe(null)

    llm.setDefault('distill', (request) => {
      const title = request.messages[0]?.content.match(/^Product title: (.*)$/m)?.[1] ?? ''
      return sheetFor(title)
    })
    const second = await runDistill(deps(llm), { jobId: first.jobId, stepId: first.stepId })

    expect(second.outcome.status).toBe('succeeded')
    const output = second.outcome.status === 'succeeded' ? (second.outcome.output as DistillOutput) : undefined
    // Two products were finished before the crash and are not distilled again.
    expect(output?.productsReplayed).toBe(2)
    expect(output?.productsDistilled).toBe(2)
    const sheets = await productFactsForAccount(harness.db, accountScope(accountId))
    expect(sheets).toHaveLength(4)
  })

  it('stops rather than writing empty sheets when the process has no model client', async () => {
    await insertProduct({ shopifyId: '1', title: 'Tote One', bodyHtml: longDescription('one'), checksum: 'c1' })

    const { outcome } = await runDistill(deps())

    expect(outcome.status).toBe('dead_lettered')
    const sheets = await productFactsForAccount(harness.db, accountScope(accountId))
    expect(sheets).toEqual([])
  })
})

/** Long enough to be worth a model call: a real description, not two words. */
function longDescription(marker: string): string {
  return `<p>Product ${marker}. Premium full-grain leather with a cotton lining. Holds 20 L. Perfect for commuting to the office and back.</p>`
}
