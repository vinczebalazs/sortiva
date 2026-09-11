/**
 * Reading a store's orders without ever holding a shopper's details.
 *
 * This is the one module in the product that touches order data, and it exists
 * to answer two questions: what does this store actually sell most of, and which
 * of its pages did the people who bought arrive on. Both are answerable from
 * line items and a landing address alone.
 *
 * Everything else an order carries — the buyer's name, email, phone, both
 * addresses, their browser's address, whatever they typed into a gift-message
 * box — is discarded here, at the moment the order is read, before anything is
 * written anywhere. That is what lets us answer Shopify's customer-data requests
 * with "we hold none": not a policy we follow, but a shape the data never has.
 *
 * The rule is enforced by construction rather than by care: `stripOrder` builds
 * a new object out of a fixed list of fields, so a field Shopify adds next year
 * is dropped by default instead of being carried along.
 */

/**
 * How far back best-sellers are computed over.
 *
 * Sixty days because that is all Shopify gives an app like ours: reading orders
 * older than that needs a separate permission Shopify grants case by case, and
 * asking for ninety days without it silently returned sixty while every column
 * and label said ninety.
 */
export const ORDER_WINDOW_DAYS = 60

/** How many best sellers we keep. */
export const TOP_PRODUCTS_KEPT = 10

/** One line of an order, with nothing on it that could name a person. */
export interface SafeLineItem {
  /** Shopify's product id, or null for a line that no longer points at one. */
  readonly productId: string | null
  readonly title: string
  /** Units the buyer still has: refunded and removed ones are already gone from it. */
  readonly quantity: number
  /** Per unit, after every discount, in the store's own currency. */
  readonly price: number
  /** What the line earned: the units still held, at the discounted price. */
  readonly net: number
}

/** One order, reduced to the two things we are allowed to keep. */
export interface SafeOrder {
  /**
   * The store's own calendar day. "Tuesday's revenue" means the merchant's
   * Tuesday, so the moment Shopify reports is read in the store's time zone.
   */
  readonly day: string
  readonly currency: string
  /** The path a buyer arrived on, without its query string. Null when Shopify recorded none. */
  readonly landingUrl: string | null
  /** What the order earned: its lines, after discounts and refunds, without tax or postage. */
  readonly total: number
  readonly lineItems: readonly SafeLineItem[]
}

/**
 * An order as the Admin client hands it over.
 *
 * Only the fields we read are named, and naming them is the point: everything
 * absent from this list is absent from what we keep, and absent from what is
 * ever asked for. The buyer, their addresses, email, phone, browser details and
 * anything they typed into a box are all deliberately not here.
 */
export interface ShopifyOrder {
  readonly id?: number | string
  /** When the order was placed, as Shopify reports it: an instant, in UTC. */
  readonly createdAt?: string | null
  readonly currency?: string | null
  /** The page the buyer arrived on in the visit that led to the order. */
  readonly landingPage?: string | null
  readonly cancelledAt?: string | null
  readonly test?: boolean | null
  readonly lineItems?: readonly ShopifyLineItem[]
}

export interface ShopifyLineItem {
  readonly productId?: string | null
  readonly title?: string | null
  /** Units still held by the buyer, refunds and removals already deducted. */
  readonly quantity?: number | null
  /** Per unit, after every discount, in the store's own currency. */
  readonly unitPrice?: string | number | null
  /**
   * Gift cards are excluded from revenue. Selling one takes money for something
   * not yet chosen; counting it would credit the gift card as a best seller and
   * then credit the products it eventually buys all over again.
   */
  readonly isGiftCard?: boolean | null
}

/**
 * Reduces one order to what may be kept.
 *
 * Returns undefined for orders that are not sales: Shopify's own test orders
 * would otherwise show up as best sellers on a store that has never sold
 * anything, and a cancelled order is not a purchase.
 */
export function stripOrder(order: ShopifyOrder, timeZone: string | null | undefined): SafeOrder | undefined {
  if (order.test === true) return undefined
  if (order.cancelledAt) return undefined

  const day = storeDayOf(order.createdAt, timeZone)
  if (!day) return undefined

  const lineItems = (order.lineItems ?? [])
    .filter((line) => line.isGiftCard !== true)
    .map((line) => {
      const quantity = Math.max(0, Math.trunc(Number(line.quantity ?? 0)) || 0)
      const price = money(line.unitPrice)
      return {
        productId: line.productId === null || line.productId === undefined ? null : String(line.productId),
        title: typeof line.title === 'string' ? line.title : '',
        quantity,
        price,
        net: round2(price * quantity),
      }
    })

  return {
    day,
    currency: typeof order.currency === 'string' ? order.currency : '',
    landingUrl: landingPathOf(order.landingPage),
    total: round2(lineItems.reduce((sum, line) => sum + line.net, 0)),
    lineItems,
  }
}

/**
 * The day an order belongs to, in the store's own reckoning.
 *
 * Shopify reports the moment in UTC, so a store in Los Angeles selling
 * something at five in the afternoon reports it as the small hours of the next
 * day. Counting that as the next day's takings would misplace every evening
 * order in a store west of Greenwich, so the store's own time zone decides.
 *
 * Without a known time zone the instant is read as it stands, which is right
 * for a store on UTC and the only honest fallback for one whose zone we could
 * not read.
 */
export function storeDayOf(
  createdAt: string | null | undefined,
  timeZone: string | null | undefined,
): string | undefined {
  if (!createdAt) return undefined
  const at = new Date(createdAt)
  if (Number.isNaN(at.getTime())) {
    const day = createdAt.slice(0, 10)
    return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : undefined
  }
  if (!timeZone) return at.toISOString().slice(0, 10)
  try {
    // `en-CA` formats as YYYY-MM-DD, which is the shape the column holds.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(at)
  } catch {
    // A time zone Shopify named and this runtime does not know. Better the
    // store's orders land on a UTC day than on no day at all.
    return at.toISOString().slice(0, 10)
  }
}

/**
 * The page someone arrived on, kept as a path.
 *
 * The query string is dropped. It carries campaign parameters and click ids,
 * which are per-visitor and belong to the shopper, and keeping them would also
 * split one landing page into a hundred rows that mean the same thing.
 */
export function landingPathOf(landingSite: string | null | undefined): string | null {
  if (!landingSite) return null
  const raw = landingSite.trim()
  if (raw.length === 0) return null
  try {
    // Shopify usually sends a path; a base makes both forms parse the same way.
    const url = new URL(raw, 'https://store.invalid')
    return url.pathname || '/'
  } catch {
    return null
  }
}

/** Running totals for one product, across the window. */
export interface ProductTotals {
  readonly title: string
  readonly quantity: number
  readonly revenue: number
}

/** Running totals for one landing page on one day. */
export interface LandingDayTotals {
  readonly day: string
  readonly landingUrl: string
  readonly orders: number
  readonly revenue: number
  readonly currency: string
}

/**
 * The accumulator a paginated read of the orders carries between pages.
 *
 * Kept small on purpose. Product totals are bounded by the size of the catalogue
 * — a few hundred entries — and the landing totals hold only the days not yet
 * written out, which is why the caller flushes finished days as it goes rather
 * than holding ninety days of pages in a checkpoint.
 */
export interface OrderAggregate {
  readonly products: Readonly<Record<string, ProductTotals>>
  readonly landing: Readonly<Record<string, LandingDayTotals>>
  /** The latest store-day seen so far; days before it can never gain more orders. */
  readonly latestDay: string | null
  readonly ordersSeen: number
}

export function emptyAggregate(): OrderAggregate {
  return { products: {}, landing: {}, latestDay: null, ordersSeen: 0 }
}

/**
 * Folds one page of orders into the running totals.
 *
 * Pure and total: the same page folded into the same accumulator always gives
 * the same answer, which is what makes a resumed sync land on the same numbers
 * as one that was never interrupted.
 */
export function accumulateOrders(
  aggregate: OrderAggregate,
  orders: readonly ShopifyOrder[],
  timeZone: string | null | undefined,
): OrderAggregate {
  const products: Record<string, ProductTotals> = { ...aggregate.products }
  const landing: Record<string, LandingDayTotals> = { ...aggregate.landing }
  let latestDay = aggregate.latestDay
  let ordersSeen = aggregate.ordersSeen

  for (const raw of orders) {
    const order = stripOrder(raw, timeZone)
    if (!order) continue
    ordersSeen += 1
    if (!latestDay || order.day > latestDay) latestDay = order.day

    for (const line of order.lineItems) {
      if (!line.productId) continue
      const existing = products[line.productId]
      products[line.productId] = {
        title: line.title || existing?.title || '',
        quantity: (existing?.quantity ?? 0) + line.quantity,
        revenue: round2((existing?.revenue ?? 0) + line.net),
      }
    }

    if (order.landingUrl) {
      const key = `${order.day}|${order.landingUrl}`
      const existing = landing[key]
      landing[key] = {
        day: order.day,
        landingUrl: order.landingUrl,
        orders: (existing?.orders ?? 0) + 1,
        revenue: round2((existing?.revenue ?? 0) + order.total),
        currency: order.currency || existing?.currency || '',
      }
    }
  }

  return { products, landing, latestDay, ordersSeen }
}

/**
 * Splits the landing totals into the days that can no longer change and the
 * days that still can.
 *
 * Orders are read oldest first, so once an order from a later day has been seen
 * every earlier day is final and can be written out. Without this the whole
 * window's landing totals would have to be carried in the checkpoint, which for
 * a busy store is megabytes of JSON re-written after every page.
 */
export function settleLandingDays(aggregate: OrderAggregate): {
  readonly settled: readonly LandingDayTotals[]
  readonly remaining: OrderAggregate
} {
  const latest = aggregate.latestDay
  if (!latest) return { settled: [], remaining: aggregate }

  const settled: LandingDayTotals[] = []
  const remaining: Record<string, LandingDayTotals> = {}
  for (const [key, totals] of Object.entries(aggregate.landing)) {
    if (totals.day < latest) settled.push(totals)
    else remaining[key] = totals
  }
  return { settled, remaining: { ...aggregate, landing: remaining } }
}

/** Whatever is left once the last page has been read. */
export function drainLandingDays(aggregate: OrderAggregate): readonly LandingDayTotals[] {
  return Object.values(aggregate.landing)
}

/** One best seller, ready to be written. */
export interface TopProduct {
  readonly shopifyProductId: string
  readonly title: string
  readonly revenue: number
  readonly quantity: number
  readonly rank: number
}

/**
 * The store's best sellers, ranked by what they earned.
 *
 * Revenue rather than quantity, because a store selling one sofa and four
 * hundred coasters is a sofa store. Quantity is kept alongside so a later
 * screen can sort the other way without another read of the orders.
 *
 * Ties break on quantity and then on the product id, so two runs over the same
 * orders produce the same order of rows rather than an arbitrary one.
 */
export function rankTopProducts(
  aggregate: OrderAggregate,
  keep: number = TOP_PRODUCTS_KEPT,
): readonly TopProduct[] {
  return Object.entries(aggregate.products)
    .map(([shopifyProductId, totals]) => ({ shopifyProductId, ...totals }))
    .sort(
      (a, b) =>
        b.revenue - a.revenue ||
        b.quantity - a.quantity ||
        a.shopifyProductId.localeCompare(b.shopifyProductId),
    )
    .slice(0, keep)
    .map((entry, index) => ({
      shopifyProductId: entry.shopifyProductId,
      title: entry.title,
      revenue: entry.revenue,
      quantity: entry.quantity,
      rank: index + 1,
    }))
}

function money(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === '') return 0
  const amount = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(amount) ? amount : 0
}

/** Money, kept to the two decimal places the column stores. */
function round2(value: number): number {
  return Math.round(value * 100) / 100
}
