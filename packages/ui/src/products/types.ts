/**
 * What the Products screen reads. Hand-written here rather than derived from the
 * API's schemas, for the reasons the sibling screens record: the schema is the
 * contract, this is one consumer's view of it, and the screen contract beside
 * this folder is what keeps them from drifting.
 */

export type RichnessBand = 'rich' | 'okay' | 'sparse'

/**
 * A product we could not say enough about, and the task that would fix it.
 *
 * The merchant fixes these in Shopify, never here: the catalogue is theirs and
 * we hold a read-only copy of it, so a field typed into Sortiva would be a
 * second, diverging truth about their own product.
 */
export interface TaskProduct {
  readonly id: string
  readonly title: string
  readonly missingFields: readonly string[]
  /** Deep link into the merchant's Shopify admin for this product. */
  readonly shopifyAdminUrl: string
}

/**
 * One blocked opportunity, rendered as work the merchant can do.
 *
 * It names the opportunity it is holding up and what that is worth, so the task
 * arrives with a reason attached rather than as a chore.
 */
export interface MerchantTask {
  readonly opportunityId: string
  readonly blockingTitle: string
  readonly impact: 'high' | 'medium' | 'low'
  readonly products: readonly TaskProduct[]
  /** Set once the products carry what was missing; the card then folds away. */
  readonly completedAt: string | null
}

export interface ProductRow {
  readonly id: string
  readonly title: string
  readonly familyId: string | null
  readonly factCount: number
  readonly richnessBand: RichnessBand
  readonly missingFields: readonly string[]
  readonly lastSyncedAt: string
}

export interface Richness {
  readonly band: RichnessBand
  readonly productsMissingDetails: number
}

export interface ProductsResponse {
  readonly richness: Richness
  readonly counts: { readonly products: number; readonly families: number }
  readonly merchantTasks: readonly MerchantTask[]
  readonly products: readonly ProductRow[]
  readonly cursor: string | null
}

/**
 * A group of products one article can sensibly cover, and what makes its members
 * different from one another.
 *
 * Read-only in this version: grouping decides what a single article can span, so
 * a merchant splitting or merging families would change what the engine is
 * allowed to write about. What they can do is tell us a grouping is wrong.
 *
 * The same shape the confirmation screen already reads, and deliberately the
 * same type: `GET /api/profile` and `GET /api/products/families` answer with one
 * family shape, and the spec asks for the same list and the same report modal on
 * both screens. Two copies of the type would be two places to edit.
 */
export type { DraftFamily as Family } from '../onboarding/confirmation'

export interface FamiliesResponse {
  readonly families: readonly import('../onboarding/confirmation').DraftFamily[]
}
