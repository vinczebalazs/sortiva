/**
 * What can go wrong under a published article, and what each of those things
 * is worth doing about.
 *
 * The catalogue is alive and a published article is not. Once an article is on
 * a merchant's site it goes on saying whatever it said, so the store moving
 * underneath it — a product withdrawn, a product unbuyable for weeks, a range
 * that no longer differs the way it did — is the one way our own content turns
 * into something worse than no content: a wrong page that ranks.
 *
 * This file is the whole judgement, as data. Nothing here reads a database or
 * decides who does the work; it says only "this happened, and this is the kind
 * of answer it deserves".
 */

/** One kind of thing that can go wrong under an article. */
export type DriftKind =
  /** The store no longer has a product an article links to or recommends. */
  | 'product_deleted'
  /** Every variant of a product has been unbuyable for long enough that recommending it is wrong. */
  | 'product_out_of_stock'
  /** The range an article compares changed shape: the attributes members differ by are not the ones it was written around. */
  | 'family_axes_changed'
  /** A collection went away, so the grouping its members were placed by has to be worked out again. */
  | 'collection_deleted'

/** Which queue an event lands in, in the vocabulary main §14.1 uses. */
export type DriftQueue =
  /** Fix the published article. Mechanical where a mechanical fix exists; otherwise it becomes a rewrite. */
  | 'repair'
  /** Rewrite the article through the normal writing and grading pipeline; it costs a calendar day. */
  | 'refresh'
  /** Nothing about an article is wrong; the catalogue's own grouping is what has to be redone. */
  | 'regroup'
  /** Deliberately nothing. */
  | 'none'

export interface DriftPolicy {
  readonly kind: DriftKind
  readonly queue: DriftQueue
  /**
   * Which opportunity a merchant sees this as. `broken_product_reference` is
   * "the page names something that is not there"; `product_change_impact` is
   * "the page is still coherent but no longer describes what is being sold".
   */
  readonly signalType: 'broken_product_reference' | 'product_change_impact'
}

/**
 * The policy table.
 *
 * Deliberately a table and not a chain of `if`s: it is the thing a reader of
 * this code most needs to be able to check against the product's own rules, and
 * a table can be read in one glance.
 *
 * **The price-drift row that used to sit here is gone.** A price differing by a
 * fifth from the one captured when the article was written used to queue the
 * article for rewriting. Under the reference model — a body never stores a
 * price, only a pointer to the product and the field, filled in from the live
 * store every time the article leaves us — the article was never wrong in the
 * first place, so there is nothing to correct and no day of the calendar to
 * spend. Founder decision of 2026-09-01, recorded in `DECISIONS.md`; it departs
 * from the drift table in the main spec as that document is still written.
 */
const POLICIES: Readonly<Record<DriftKind, DriftPolicy>> = {
  product_deleted: {
    kind: 'product_deleted',
    queue: 'repair',
    signalType: 'broken_product_reference',
  },
  product_out_of_stock: {
    kind: 'product_out_of_stock',
    queue: 'repair',
    signalType: 'product_change_impact',
  },
  family_axes_changed: {
    kind: 'family_axes_changed',
    queue: 'refresh',
    signalType: 'product_change_impact',
  },
  collection_deleted: {
    kind: 'collection_deleted',
    queue: 'regroup',
    signalType: 'product_change_impact',
  },
}

export function driftPolicyFor(kind: DriftKind): DriftPolicy {
  return POLICIES[kind]
}

export function driftPolicies(): readonly DriftPolicy[] {
  return Object.values(POLICIES)
}

/**
 * A change the store reported, read as drift or read as nothing.
 *
 * Every kind the shared change record can carry is named here, including the
 * ones that mean nothing to a published article, so that a change type going
 * unhandled is a compile error rather than a silent miss.
 *
 * `price_changed` returning nothing is the founder decision above, made
 * visible: the value in the body re-renders on the next hand-over and no
 * article is queued for anything.
 *
 * `availability_changed` also returns nothing on its own. Stock moving is not
 * drift — a product being unbuyable *for a fortnight* is, and no single event
 * can say that. The daily pass works that out from how long ago the stock last
 * moved.
 */
export function driftFromCatalogChangeKind(kind: string): DriftKind | undefined {
  switch (kind) {
    case 'product_deleted':
      return 'product_deleted'
    case 'price_changed':
    case 'availability_changed':
    case 'product_created':
    case 'product_updated':
    case 'collection_updated':
    case 'article_updated':
    case 'article_deleted':
    case 'page_updated':
    case 'page_deleted':
      return undefined
    default:
      return undefined
  }
}

/**
 * Whether a stretch of being unbuyable has gone on long enough to be wrong.
 *
 * `since` is when the product's stock last moved. A product that comes back
 * before the threshold clears itself: the pass simply stops seeing it as
 * unbuyable and the flag never appears, which is main §14.1's "back-in-stock
 * clears the flag" with no clearing step to forget to run.
 */
export function outOfStockLongEnough(
  since: Date | null,
  now: Date,
  daysMin: number,
): boolean {
  if (!since) return false
  const days = (now.getTime() - since.getTime()) / 86_400_000
  return days >= daysMin
}
