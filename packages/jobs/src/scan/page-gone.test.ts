import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { findExistingTarget, type QueryCluster } from '@sortiva/core'
import { MockSeoDataProvider } from '@sortiva/providers/seo/mock'
import { accountScope, markStorePagesGoneNotSeenSince, upsertStorePages, type StorePageInput } from '@sortiva/db'
import { databaseAvailable, insertAccount, setupTestDb, truncateAll, type TestDb } from '@sortiva/db/testing'
import { rules } from '@sortiva/rules'
import { assembleExistingTargetCoverage, assembleFamilyCoverageInput, assembleMetadataInput } from './assemble'
import { existingTargetInputFor } from './existing-target'

const available = await databaseAvailable()

/**
 * What the product stops doing once it can see that a merchant deleted a page.
 *
 * The consequence runs both ways, which is the whole reason this matters: a
 * deleted page used to block a new article on the subject it covered, *and* it
 * used to attract suggestions to improve something that is not there. Which one
 * a store got depended only on which side of the deletion the check fell.
 */

const FAMILY = '11111111-1111-4111-8111-111111111111'
const T0 = new Date('2026-09-07T03:00:00Z')
const T1 = new Date('2026-09-08T03:00:00Z')

function page(over: Partial<StorePageInput> = {}): StorePageInput {
  return {
    url: 'https://shop.example/collections/boots',
    pageType: 'collection',
    handle: 'boots',
    shopifyId: '1',
    title: 'Boots',
    seoTitle: 'Boots',
    seoDescription: 'Every boot we sell.',
    headings: [],
    bodyHtml: '<p>Boots.</p>',
    outboundInternalLinks: [],
    familyIds: [FAMILY],
    checksum: 'checksum-1',
    ...over,
  }
}

const cluster: QueryCluster = {
  head: 'walking boots',
  members: ['walking boots'],
  familyIds: [FAMILY],
  intentClass: 'buying_guide',
}

describe.skipIf(!available)('once a deleted page is visible to the scan', () => {
  let ctx: TestDb
  let pool: pg.Pool
  let accountId: string

  beforeAll(async () => {
    ctx = await setupTestDb('page_gone_read')
    pool = ctx.pool
  })

  afterAll(async () => {
    await ctx?.close()
  })

  beforeEach(async () => {
    await truncateAll(pool)
    accountId = await insertAccount(pool, 'page-gone@example.com')
  })

  /** Plants the page, then removes it the way a completed walk would. */
  async function plant(deleted: boolean, over: Partial<StorePageInput> = {}) {
    const scope = accountScope(accountId)
    await upsertStorePages(ctx.db, scope, [page(over)], T0)
    if (deleted) await markStorePagesGoneNotSeenSince(ctx.db, scope, T1)
  }

  /** A range of products, so a coverage candidate exists to be covered at all. */
  async function plantFamily() {
    await pool.query(
      `insert into product_families (id, account_id, name, member_count, grouping_source, confidence)
       values ($1, $2, 'Boots', 3, 'collection', 'high')`,
      [FAMILY, accountId],
    )
  }

  function deps() {
    return { db: ctx.db, seo: new MockSeoDataProvider(), rules: rules().defaults, now: () => T1 }
  }

  describe('the check that stops us writing a page we already have', () => {
    it('still refuses a new page while the existing one is served', async () => {
      await plant(false)

      const result = findExistingTarget(await existingTargetInputFor(deps(), accountId, cluster))

      // The page is found and the new article is tied to it: either it takes the
      // work over outright, or a new page may go ahead only with a link between
      // the two so they never compete blind.
      expect(result.match?.url).toBe('https://shop.example/collections/boots')
      expect(result.clearance?.weakExistingTarget ?? result.match?.url).toBe(
        'https://shop.example/collections/boots',
      )
    })

    it('clears the way once the merchant has deleted it', async () => {
      await plant(true)

      const result = findExistingTarget(await existingTargetInputFor(deps(), accountId, cluster))

      // Nothing left to improve, so holding it against a new article would keep
      // the store short of coverage it no longer has. And the clearance is a
      // free one — no page to link back to, because there is no page.
      expect(result.match).toBeNull()
      expect(result.clearance).not.toBeNull()
      expect(result.clearance?.weakExistingTarget).toBeNull()
      expect(result.clearance?.linkTasks).toEqual([])
    })

    it('reads the removal off the row rather than the row being absent', async () => {
      await plant(true)

      const input = await existingTargetInputFor(deps(), accountId, cluster)

      // The check must still be handed the deleted row: a page it holds no row
      // for is one it has no opinion about, and it treats that as published.
      // Filtering deleted rows out here would turn every deletion back into a
      // live page.
      expect(input.pages).toHaveLength(1)
      expect(input.pages[0]?.presence).toBe('removed')
    })

    it('reports a served page as published, not merely unconfirmed', async () => {
      await plant(false)

      const input = await existingTargetInputFor(deps(), accountId, cluster)

      expect(input.pages[0]?.presence).toBe('published')
    })
  })

  describe('the suggestions a scan produces', () => {
    it('stops asking a merchant to improve a page they deleted', async () => {
      await plant(true, { seoTitle: null, seoDescription: null })

      const input = await assembleMetadataInput(deps(), accountId)

      expect(input.pages).toEqual([])
    })

    it('still asks about a served page with nothing written on it', async () => {
      await plant(false, { seoTitle: null, seoDescription: null })

      const input = await assembleMetadataInput(deps(), accountId)

      expect(input.pages).toHaveLength(1)
      expect(input.pages[0]?.seoTitle).toBeNull()
    })

    it('still counts a served page as coverage of its subject', async () => {
      await plantFamily()
      await plant(false)

      const coverage = await assembleExistingTargetCoverage(deps(), accountId, [], [
        { id: FAMILY, name: 'Boots' },
      ])
      const input = await assembleFamilyCoverageInput(deps(), accountId, [], coverage.byFamily)

      expect(input.candidates).toHaveLength(1)
      expect(input.candidates[0]?.mappedContent.map((c) => c.url)).toEqual([
        'https://shop.example/collections/boots',
      ])
    })

    it('stops counting a deleted page as coverage of its subject', async () => {
      await plantFamily()
      await plant(true)

      const coverage = await assembleExistingTargetCoverage(deps(), accountId, [], [
        { id: FAMILY, name: 'Boots' },
      ])
      const input = await assembleFamilyCoverageInput(deps(), accountId, [], coverage.byFamily)

      // The opposite direction from the two above: here a stale row does not
      // produce a suggestion that should not exist, it suppresses one that
      // should — the range reads as already covered by a page nobody can visit,
      // so the product stays quiet about writing a replacement.
      expect(input.candidates).toHaveLength(1)
      expect(input.candidates[0]?.mappedContent).toEqual([])
    })
  })
})
