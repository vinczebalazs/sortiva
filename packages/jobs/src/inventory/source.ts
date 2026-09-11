import type {
  InventoryCursor,
  InventoryTarget,
  ShopifyAuth,
  StoreContentBatch,
  StoreContentKind,
  StoreContentRecord,
  StoreContentSource,
} from '@sortiva/core'
import { TerminalFailure } from '../runtime/errors'
import type { ShopifyAdminReader } from './deps'

/**
 * Reading a Shopify store's published things through its admin interface.
 *
 * The store tells us what it has; we never go and look. Everything here is a
 * list the merchant could open in their own admin — collections, products,
 * pages and blog posts.
 *
 * The walk is staged and resumable. A store answers a bounded number of requests
 * a minute, so a large store is a long walk that has to survive being killed
 * halfway; the cursor names the stage and the store's own marker for where the
 * next page of it begins, and the job hands it back to the queue when it runs
 * out of budget.
 */

/**
 * The order the store is walked in, and it is not arbitrary: collections come
 * first because they carry product membership, which is what gives every later
 * row its product families.
 */
const STAGES = ['collection', 'product', 'page', 'blog_article'] as const satisfies readonly StoreContentKind[]
type Stage = (typeof STAGES)[number]

/**
 * The largest page one request asks for, matching what the Shopify client's
 * content queries are costed against. A store meters us by how expensive a query
 * is rather than by how many we send, so a bigger page is not a cheaper walk —
 * it is one request that can be refused for costing too much.
 */
const MAX_PAGE_SIZE = 100

export interface ShopifyInventorySourceOptions {
  /**
   * How many of a collection's products to read when working out which families
   * it covers. One request's worth: a collection with more members than this
   * already tells us everything about which families it is about, and paging
   * through a thousand-product collection nightly would buy nothing.
   */
  readonly membershipSampleSize?: number
}

const MEMBERSHIP_SAMPLE = 250

export class ShopifyInventorySource implements StoreContentSource {
  private readonly origins = new Map<string, string>()

  constructor(
    private readonly admin: ShopifyAdminReader,
    private readonly authFor: (accountId: string) => Promise<ShopifyAuth | undefined>,
    private readonly options: ShopifyInventorySourceOptions = {},
  ) {}

  /**
   * The address the store actually serves on, asked of the store itself.
   *
   * Not the domain the merchant claimed with us: search engines report the
   * canonical storefront address, and an inventory spelled the other way would
   * never join against the search data it exists to be compared with. A store
   * that has no domain of its own is still served under its Shopify one.
   */
  async storefrontOrigin(accountId: string): Promise<string> {
    const cached = this.origins.get(accountId)
    if (cached) return cached
    const auth = await this.auth(accountId)
    const shop = await this.admin.getShop(auth)
    const origin = `https://${shop.primaryDomain ?? shop.myshopifyDomain}`
    this.origins.set(accountId, origin)
    return origin
  }

  async next(
    accountId: string,
    cursor: InventoryCursor | undefined,
    limit: number,
  ): Promise<StoreContentBatch> {
    const auth = await this.auth(accountId)
    const stage = stageOf(cursor) ?? STAGES[0]

    const page = await this.admin.listContent(auth, {
      kind: stage,
      first: Math.min(Math.max(limit, 1), MAX_PAGE_SIZE),
      // Opaque and the store's to shape: it is handed back exactly as it came.
      after: cursor?.['after'],
    })
    const records = await this.withMembership(auth, page.items)

    // The store says whether there is more of this stage. Being told there is
    // not is what moves the walk on; running off the last stage is what says the
    // whole store has been read.
    return page.next
      ? { records, next: { stage, after: page.next } }
      : { records, ...nextStage(stage) }
  }

  /**
   * Re-reads exactly the things a webhook named.
   *
   * A thing the store no longer has is dropped rather than raised: by the time
   * we ask, a merchant who deleted a page has already deleted it, and that is
   * the ordinary case rather than a fault. Only the store answering "there is no
   * such thing" drops one — a request that failed is raised, so a bad reading of
   * the store can never be mistaken for the merchant emptying it.
   */
  async read(
    accountId: string,
    targets: readonly InventoryTarget[],
  ): Promise<readonly StoreContentRecord[]> {
    const auth = await this.auth(accountId)
    const found: StoreContentRecord[] = []
    for (const target of targets) {
      const record = await this.admin.readContent(auth, target)
      if (record) found.push(record)
    }
    return this.withMembership(auth, found)
  }

  /**
   * Fills in which products a collection holds.
   *
   * The one extra request the walk makes per row, and only for collections:
   * everything else the inventory keeps — the search title and description
   * included — arrives with the page that named the thing.
   */
  private async withMembership(
    auth: ShopifyAuth,
    records: readonly StoreContentRecord[],
  ): Promise<StoreContentRecord[]> {
    const sample = this.options.membershipSampleSize ?? MEMBERSHIP_SAMPLE
    const out: StoreContentRecord[] = []
    for (const record of records) {
      if (record.kind !== 'collection') {
        out.push(record)
        continue
      }
      const members = await this.admin.collectionMemberIds(auth, record.shopifyId, sample)
      out.push({ ...record, memberProductIds: members })
    }
    return out
  }

  private async auth(accountId: string): Promise<ShopifyAuth> {
    const auth = await this.authFor(accountId)
    if (!auth) {
      throw new TerminalFailure('no_connection', 'This store has no working Shopify connection.')
    }
    return auth
  }
}

function stageOf(cursor: InventoryCursor | undefined): Stage | undefined {
  const stage = cursor?.['stage']
  return STAGES.includes(stage as Stage) ? (stage as Stage) : undefined
}

function nextStage(stage: Stage): { next?: InventoryCursor } {
  const following = STAGES[STAGES.indexOf(stage) + 1]
  return following ? { next: { stage: following } } : {}
}
