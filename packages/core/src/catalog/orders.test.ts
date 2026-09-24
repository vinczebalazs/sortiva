import { describe, expect, it } from 'vitest'
import {
  ORDER_WINDOW_DAYS,
  accumulateOrders,
  drainLandingDays,
  emptyAggregate,
  landingPathOf,
  rankTopProducts,
  settleLandingDays,
  storeDayOf,
  stripOrder,
  type ShopifyLineItem,
  type ShopifyOrder,
} from './orders'

/**
 * Invariant 4 — order ingestion strips all customer fields at read time; only
 * line-item and landing-page aggregates are persisted.
 *
 * The test that matters most in this file is the first one. It takes an order
 * carrying a customer record, both addresses, an email, a phone number, a
 * browser address and a gift message a shopper typed, and asserts that none of
 * those values survives the read. Not that we do not *write* them: that they are
 * not in the object anything downstream could write.
 *
 * Since the move to Shopify's GraphQL API the protection is doubled. The query
 * names every field it wants, so a shopper's details are never asked for and
 * never arrive. This suite hands them over anyway — the fixture is deliberately
 * wider than the shape the reader declares — because "we do not ask" is one
 * padlock and "it would not survive if we did" is the other, and the second is
 * the one that still holds when somebody edits the query.
 */

/** The store's own clock. Its calendar day is what a merchant means by "Tuesday". */
const STORE_TZ = 'Europe/Berlin'

/** Every field on this order that belongs to a person rather than to a sale. */
const SHOPPER_VALUES = [
  'ada@example.com',
  '+44 7700 900123',
  'Ada',
  'Lovelace',
  '12 Marylebone Road',
  'London',
  'NW1 5LA',
  '203.0.113.42',
  'Gift note for Ada Lovelace, 12 Marylebone Road',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
]

/**
 * An order node carrying more than the reader declares.
 *
 * Shopify's API can return every one of these fields; ours is a query that does
 * not ask. Typing the fixture wider than `ShopifyOrder` is the point: it is what
 * lets the strip be tested against data it should never see.
 */
type RawLineItemNode = ShopifyLineItem & Record<string, unknown>
type RawOrderNode = Omit<ShopifyOrder, 'lineItems'> & {
  readonly lineItems?: readonly RawLineItemNode[]
} & Record<string, unknown>

function realisticOrder(overrides: Partial<RawOrderNode> = {}): RawOrderNode {
  return {
    id: '5001',
    // GraphQL reports instants in UTC; 16:42Z is 18:42 in the store's own day.
    createdAt: '2026-06-14T16:42:11Z',
    currency: 'EUR',
    landingPage: '/collections/trail-shoes?utm_source=google&gclid=abc123',
    cancelledAt: null,
    test: false,
    email: 'ada@example.com',
    phone: '+44 7700 900123',
    customer: {
      id: 99,
      email: 'ada@example.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
      phone: '+44 7700 900123',
      defaultAddress: { address1: '12 Marylebone Road', city: 'London', zip: 'NW1 5LA' },
    },
    billingAddress: {
      firstName: 'Ada',
      lastName: 'Lovelace',
      address1: '12 Marylebone Road',
      city: 'London',
      zip: 'NW1 5LA',
      phone: '+44 7700 900123',
    },
    shippingAddress: {
      firstName: 'Ada',
      lastName: 'Lovelace',
      address1: '12 Marylebone Road',
      city: 'London',
      zip: 'NW1 5LA',
    },
    clientIp: '203.0.113.42',
    customerJourneySummary: {
      lastVisit: { landingPage: '/collections/trail-shoes', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
    },
    note: 'Gift note for Ada Lovelace, 12 Marylebone Road',
    customAttributes: [{ key: 'gift_message', value: 'Gift note for Ada Lovelace, 12 Marylebone Road' }],
    lineItems: [
      {
        productId: '700',
        title: 'Ridgeline Trail Shoe',
        quantity: 2,
        unitPrice: '37.50',
        isGiftCard: false,
        sku: 'RTS-42',
        customAttributes: [{ key: 'Engraving', value: 'Ada' }],
      },
    ],
    ...overrides,
  }
}

describe('invariant 4 — no customer field survives reading an order', () => {
  it('keeps the sale and drops the shopper', () => {
    const safe = stripOrder(realisticOrder(), STORE_TZ)
    expect(safe).toBeDefined()

    // The whole reduced order, serialised: if a shopper's value is anywhere in
    // here it is somewhere it could be written from.
    const serialised = JSON.stringify(safe)
    for (const value of SHOPPER_VALUES) {
      expect(serialised, `"${value}" survived the read`).not.toContain(value)
    }

    // And what it did keep is the sale.
    expect(safe).toEqual({
      day: '2026-06-14',
      currency: 'EUR',
      landingUrl: '/collections/trail-shoes',
      total: 75,
      lineItems: [
        {
          productId: '700',
          title: 'Ridgeline Trail Shoe',
          quantity: 2,
          price: 37.5,
          net: 75,
        },
      ],
    })
  })

  it('drops what a shopper typed onto a line item', () => {
    // A line's custom attributes are free text a shopper fills in — an
    // engraving, a recipient's name. Being on the line rather than on the order
    // is exactly the sort of place a customer field hides.
    const safe = stripOrder(realisticOrder(), STORE_TZ)
    expect(JSON.stringify(safe?.lineItems)).not.toContain('Engraving')
  })

  it('is not vacuous: the same values are present in what Shopify sent', () => {
    // A stripping test passes trivially if the fixture never held the values.
    const sent = JSON.stringify(realisticOrder())
    for (const value of SHOPPER_VALUES) {
      expect(sent, `the fixture does not contain "${value}"`).toContain(value)
    }
  })
})

describe('which orders count as sales', () => {
  it('ignores Shopify test orders', () => {
    expect(stripOrder(realisticOrder({ test: true }), STORE_TZ)).toBeUndefined()
  })

  it('ignores cancelled orders', () => {
    expect(stripOrder(realisticOrder({ cancelledAt: '2026-06-15T07:00:00Z' }), STORE_TZ)).toBeUndefined()
  })

  it('ignores an order with no usable timestamp', () => {
    expect(stripOrder(realisticOrder({ createdAt: null }), STORE_TZ)).toBeUndefined()
  })
})

describe('how far back the orders are read', () => {
  it('stops at sixty days, which is all Shopify will give us', () => {
    // Reading further back needs a permission Shopify grants case by case.
    // Without it a request for ninety days quietly answers with sixty, so the
    // number here is the one the labels and columns have to agree with.
    expect(ORDER_WINDOW_DAYS).toBe(60)
  })
})

describe('the day an order belongs to', () => {
  it('is the store own calendar day, not the server one', () => {
    // Shopify states the instant in UTC. Half past seven on a Sunday evening in
    // Los Angeles is already Monday in UTC, and counting it as Monday would
    // misplace every evening sale in every store west of Greenwich.
    expect(storeDayOf('2026-06-15T02:30:00Z', 'America/Los_Angeles')).toBe('2026-06-14')
    // And the same in the other direction: half past eleven at night in
    // Auckland is still the previous UTC day.
    expect(storeDayOf('2026-06-14T11:30:00Z', 'Pacific/Auckland')).toBe('2026-06-14')
    expect(storeDayOf('2026-06-14T22:30:00Z', 'Pacific/Auckland')).toBe('2026-06-15')
    expect(storeDayOf('nonsense', STORE_TZ)).toBeUndefined()
  })

  it('reads the instant as it stands when the store time zone is unknown', () => {
    // Right for a store on UTC, and the only honest answer for one whose zone we
    // could not read. Landing every order on a UTC day beats landing none.
    expect(storeDayOf('2026-06-15T02:30:00Z', null)).toBe('2026-06-15')
    expect(storeDayOf('2026-06-15T02:30:00Z', 'Mars/Phobos')).toBe('2026-06-15')
  })

  it('puts an evening sale in a store west of UTC into the store own takings', () => {
    // The whole order, not just the date helper: an order placed at 19:30 on the
    // 14th in California must be the 14th's revenue on the merchant's screen.
    const evening = realisticOrder({ createdAt: '2026-06-15T02:30:00Z' })

    expect(stripOrder(evening, 'America/Los_Angeles')?.day).toBe('2026-06-14')
    expect(stripOrder(evening, null)?.day).toBe('2026-06-15')

    const aggregate = accumulateOrders(emptyAggregate(), [evening], 'America/Los_Angeles')
    expect(drainLandingDays(aggregate).map((row) => row.day)).toEqual(['2026-06-14'])
  })
})

describe('what an order earned', () => {
  const line = (overrides: Partial<RawLineItemNode>) =>
    realisticOrder({
      landingPage: '/collections/trail-shoes',
      lineItems: [
        { productId: '700', title: 'Ridgeline Trail Shoe', quantity: 1, unitPrice: '50.00', isGiftCard: false, ...overrides },
      ],
    })

  it('counts the price after every discount, not the one on the label', () => {
    // Shopify states both. Counting the label price would credit a store with
    // money it never took, and make a product on permanent discount look like
    // its best seller.
    const safe = stripOrder(line({ unitPrice: '37.50', originalUnitPrice: '50.00' }), STORE_TZ)
    expect(safe?.total).toBe(37.5)
    expect(safe?.lineItems[0]?.price).toBe(37.5)
  })

  it('counts the units the buyer still has, not the ones they first bought', () => {
    // A refunded or removed unit is already gone from the quantity Shopify
    // hands us. Reading the original count instead would keep crediting a store
    // for a sale it has since paid back.
    const safe = stripOrder(line({ quantity: 1, originalQuantity: 3, unitPrice: '50.00' }), STORE_TZ)
    expect(safe?.lineItems[0]?.quantity).toBe(1)
    expect(safe?.total).toBe(50)
  })

  it('leaves gift cards out of the money and out of the best sellers', () => {
    // Selling a gift card takes money for something not yet chosen. Counting it
    // credits the card now and the products it eventually buys all over again.
    const order = realisticOrder({
      landingPage: '/collections/trail-shoes',
      lineItems: [
        { productId: '700', title: 'Ridgeline Trail Shoe', quantity: 1, unitPrice: '50.00', isGiftCard: false },
        { productId: '900', title: 'Gift Card', quantity: 1, unitPrice: '100.00', isGiftCard: true },
      ],
    })

    const safe = stripOrder(order, STORE_TZ)
    expect(safe?.total).toBe(50)
    expect(safe?.lineItems.map((l) => l.productId)).toEqual(['700'])

    const top = rankTopProducts(accumulateOrders(emptyAggregate(), [order], STORE_TZ))
    expect(top.map((t) => t.shopifyProductId)).toEqual(['700'])
  })

  it('carries no tax and no postage, because it never reads either', () => {
    // The total is built from the lines upwards rather than taken from the
    // order's own total, so what a store is credited with is what it sold.
    const safe = stripOrder(
      realisticOrder({
        lineItems: [
          { productId: '700', title: 'Ridgeline Trail Shoe', quantity: 2, unitPrice: '37.50', isGiftCard: false },
        ],
        totalPrice: '104.25',
        totalTax: '14.25',
        totalShipping: '15.00',
      }),
      STORE_TZ,
    )
    expect(safe?.total).toBe(75)
  })
})

describe('the page a buyer arrived on', () => {
  it('keeps the path and drops the query', () => {
    expect(landingPathOf('/collections/boots?utm_campaign=spring&gclid=x')).toBe('/collections/boots')
    expect(landingPathOf('https://shop.example/products/one?ref=abc')).toBe('/products/one')
    expect(landingPathOf('/')).toBe('/')
    expect(landingPathOf(null)).toBeNull()
    expect(landingPathOf('   ')).toBeNull()
  })
})

describe('adding up a window of orders', () => {
  const page = (day: string, productId: number, quantity: number, unitPrice: string) =>
    realisticOrder({
      createdAt: `${day}T10:00:00Z`,
      landingPage: '/collections/trail-shoes',
      lineItems: [
        { productId: String(productId), title: `Product ${productId}`, quantity, unitPrice, isGiftCard: false },
      ],
    })

  it('ranks best sellers by what they earned, keeping quantity alongside', () => {
    let aggregate = emptyAggregate()
    aggregate = accumulateOrders(
      aggregate,
      [
        page('2026-06-01', 700, 1, '500.00'),
        page('2026-06-01', 701, 20, '10.00'),
        page('2026-06-02', 701, 5, '10.00'),
      ],
      STORE_TZ,
    )

    const top = rankTopProducts(aggregate)
    expect(top.map((t) => [t.shopifyProductId, t.rank, t.revenue, t.quantity])).toEqual([
      ['700', 1, 500, 1],
      ['701', 2, 250, 25],
    ])
  })

  it('keeps only as many best sellers as asked for', () => {
    let aggregate = emptyAggregate()
    aggregate = accumulateOrders(
      aggregate,
      Array.from({ length: 15 }, (_unused, i) => page('2026-06-01', 800 + i, 1, `${100 - i}.00`)),
      STORE_TZ,
    )
    expect(rankTopProducts(aggregate)).toHaveLength(10)
  })

  it('gives the same answer whether the pages arrive in one call or several', () => {
    const orders = [
      page('2026-06-01', 700, 1, '500.00'),
      page('2026-06-01', 701, 2, '10.00'),
      page('2026-06-02', 700, 3, '500.00'),
    ]
    const inOneGo = accumulateOrders(emptyAggregate(), orders, STORE_TZ)
    const pageByPage = orders.reduce(
      (acc, order) => accumulateOrders(acc, [order], STORE_TZ),
      emptyAggregate(),
    )
    expect(rankTopProducts(pageByPage)).toEqual(rankTopProducts(inOneGo))
    expect(drainLandingDays(pageByPage)).toEqual(drainLandingDays(inOneGo))
  })

  it('settles a day only once a later day has been seen', () => {
    let aggregate = accumulateOrders(emptyAggregate(), [page('2026-06-01', 700, 1, '10.00')], STORE_TZ)
    // Nothing later has arrived, so the first is still open: more of the day's
    // orders could be on the next page.
    expect(settleLandingDays(aggregate).settled).toEqual([])

    aggregate = accumulateOrders(aggregate, [page('2026-06-02', 700, 1, '10.00')], STORE_TZ)
    const { settled, remaining } = settleLandingDays(aggregate)
    expect(settled.map((s) => s.day)).toEqual(['2026-06-01'])
    expect(drainLandingDays(remaining).map((s) => s.day)).toEqual(['2026-06-02'])
  })

  it('counts orders and revenue per landing page per day', () => {
    const aggregate = accumulateOrders(
      emptyAggregate(),
      [page('2026-06-01', 700, 1, '10.00'), page('2026-06-01', 701, 1, '15.50')],
      STORE_TZ,
    )
    expect(drainLandingDays(aggregate)).toEqual([
      {
        day: '2026-06-01',
        landingUrl: '/collections/trail-shoes',
        orders: 2,
        revenue: 25.5,
        currency: 'EUR',
      },
    ])
  })

  it('sorts the store days by the store clock, not by the UTC one', () => {
    // Two orders either side of midnight UTC, both on the same Californian
    // evening. Read in UTC they are two days and the first settles early; read
    // in the store's own zone they are one day, still open.
    const store = 'America/Los_Angeles'
    const aggregate = accumulateOrders(
      emptyAggregate(),
      [
        realisticOrder({ createdAt: '2026-06-14T23:30:00Z', landingPage: '/collections/trail-shoes' }),
        realisticOrder({ createdAt: '2026-06-15T02:30:00Z', landingPage: '/collections/trail-shoes' }),
      ],
      store,
    )
    expect(drainLandingDays(aggregate).map((row) => [row.day, row.orders])).toEqual([['2026-06-14', 2]])
    expect(settleLandingDays(aggregate).settled).toEqual([])
  })
})
