import { describe, expect, it } from 'vitest'
import {
  accumulateOrders,
  drainLandingDays,
  emptyAggregate,
  landingPathOf,
  rankTopProducts,
  settleLandingDays,
  storeDayOf,
  stripOrder,
  type ShopifyOrder,
} from './orders'

/**
 * Invariant 4 — order ingestion strips all customer fields at read time; only
 * line-item and landing-page aggregates are persisted.
 *
 * The test that matters most in this file is the first one. It takes an order
 * shaped the way Shopify really sends them — with a customer record, both
 * addresses, an email, a phone number, a browser address and a gift message a
 * shopper typed — and asserts that none of those values survives the read. Not
 * that we do not *write* them: that they are not in the object anything
 * downstream could write.
 */

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

function realisticOrder(overrides: Partial<ShopifyOrder> = {}): ShopifyOrder {
  return {
    id: 5001,
    created_at: '2026-06-14T18:42:11+02:00',
    updated_at: '2026-06-14T18:42:11+02:00',
    currency: 'EUR',
    total_price: '84.50',
    subtotal_price: '80.00',
    landing_site: '/collections/trail-shoes?utm_source=google&gclid=abc123',
    referring_site: 'https://www.google.com/',
    email: 'ada@example.com',
    contact_email: 'ada@example.com',
    phone: '+44 7700 900123',
    browser_ip: '203.0.113.42',
    customer: {
      id: 99,
      email: 'ada@example.com',
      first_name: 'Ada',
      last_name: 'Lovelace',
      phone: '+44 7700 900123',
      default_address: { address1: '12 Marylebone Road', city: 'London', zip: 'NW1 5LA' },
    },
    billing_address: {
      first_name: 'Ada',
      last_name: 'Lovelace',
      address1: '12 Marylebone Road',
      city: 'London',
      zip: 'NW1 5LA',
      phone: '+44 7700 900123',
    },
    shipping_address: {
      first_name: 'Ada',
      last_name: 'Lovelace',
      address1: '12 Marylebone Road',
      city: 'London',
      zip: 'NW1 5LA',
    },
    client_details: {
      browser_ip: '203.0.113.42',
      user_agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      accept_language: 'en-GB',
    },
    note: 'Gift note for Ada Lovelace, 12 Marylebone Road',
    note_attributes: [{ name: 'gift_message', value: 'Gift note for Ada Lovelace, 12 Marylebone Road' }],
    line_items: [
      {
        id: 1,
        product_id: 700,
        variant_id: 7001,
        title: 'Ridgeline Trail Shoe',
        quantity: 2,
        price: '40.00',
        total_discount: '5.00',
        sku: 'RTS-42',
        properties: [{ name: 'Engraving', value: 'Ada' }],
      },
    ],
    ...overrides,
  }
}

describe('invariant 4 — no customer field survives reading an order', () => {
  it('keeps the sale and drops the shopper', () => {
    const safe = stripOrder(realisticOrder())
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
      total: 84.5,
      lineItems: [
        {
          productId: '700',
          title: 'Ridgeline Trail Shoe',
          quantity: 2,
          price: 40,
          totalDiscount: 5,
        },
      ],
    })
  })

  it('drops what a shopper typed onto a line item', () => {
    // `properties` is a free-text field a shopper fills in — an engraving, a
    // recipient's name. It is on the line item rather than on the order, which
    // is exactly the sort of place a customer field hides.
    const safe = stripOrder(realisticOrder())
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
    expect(stripOrder(realisticOrder({ test: true }))).toBeUndefined()
  })

  it('ignores cancelled orders', () => {
    expect(stripOrder(realisticOrder({ cancelled_at: '2026-06-15T09:00:00+02:00' }))).toBeUndefined()
  })

  it('ignores an order with no usable timestamp', () => {
    expect(stripOrder(realisticOrder({ created_at: null }))).toBeUndefined()
  })
})

describe('the day an order belongs to', () => {
  it('is the store own calendar day, not the server one', () => {
    // 23:30 on the 14th in a store two hours ahead of UTC is 21:30 UTC on the
    // 14th — but a store in New Zealand at 23:30 is the *previous* UTC day, and
    // converting would move the sale into yesterday's takings.
    expect(storeDayOf('2026-06-14T23:30:00+13:00')).toBe('2026-06-14')
    expect(storeDayOf('2026-06-14T01:00:00-07:00')).toBe('2026-06-14')
    expect(storeDayOf('nonsense')).toBeUndefined()
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
  const page = (day: string, productId: number, quantity: number, price: string, total: string) =>
    realisticOrder({
      created_at: `${day}T10:00:00+00:00`,
      total_price: total,
      landing_site: '/collections/trail-shoes',
      line_items: [{ product_id: productId, title: `Product ${productId}`, quantity, price, total_discount: '0.00' }],
    })

  it('ranks best sellers by what they earned, keeping quantity alongside', () => {
    let aggregate = emptyAggregate()
    aggregate = accumulateOrders(aggregate, [
      page('2026-06-01', 700, 1, '500.00', '500.00'),
      page('2026-06-01', 701, 20, '10.00', '200.00'),
      page('2026-06-02', 701, 5, '10.00', '50.00'),
    ])

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
      Array.from({ length: 15 }, (_unused, i) => page('2026-06-01', 800 + i, 1, `${100 - i}.00`, '1.00')),
    )
    expect(rankTopProducts(aggregate)).toHaveLength(10)
  })

  it('gives the same answer whether the pages arrive in one call or several', () => {
    const orders = [
      page('2026-06-01', 700, 1, '500.00', '500.00'),
      page('2026-06-01', 701, 2, '10.00', '20.00'),
      page('2026-06-02', 700, 3, '500.00', '1500.00'),
    ]
    const inOneGo = accumulateOrders(emptyAggregate(), orders)
    const pageByPage = orders.reduce((acc, order) => accumulateOrders(acc, [order]), emptyAggregate())
    expect(rankTopProducts(pageByPage)).toEqual(rankTopProducts(inOneGo))
    expect(drainLandingDays(pageByPage)).toEqual(drainLandingDays(inOneGo))
  })

  it('settles a day only once a later day has been seen', () => {
    let aggregate = accumulateOrders(emptyAggregate(), [page('2026-06-01', 700, 1, '10.00', '10.00')])
    // Nothing later has arrived, so the first is still open: more of the day's
    // orders could be on the next page.
    expect(settleLandingDays(aggregate).settled).toEqual([])

    aggregate = accumulateOrders(aggregate, [page('2026-06-02', 700, 1, '10.00', '10.00')])
    const { settled, remaining } = settleLandingDays(aggregate)
    expect(settled.map((s) => s.day)).toEqual(['2026-06-01'])
    expect(drainLandingDays(remaining).map((s) => s.day)).toEqual(['2026-06-02'])
  })

  it('counts orders and revenue per landing page per day', () => {
    const aggregate = accumulateOrders(emptyAggregate(), [
      page('2026-06-01', 700, 1, '10.00', '10.00'),
      page('2026-06-01', 701, 1, '15.00', '15.50'),
    ])
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
})
