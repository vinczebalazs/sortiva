import { describe, expect, it } from 'vitest'
import { isKnownTopic, storableWebhookBody } from './webhooks'

/**
 * Shopify's two customer-privacy messages carry the shopper's email and phone
 * in a `customer` object. We answer both by saying we hold nothing about the
 * merchant's shoppers — so keeping the message as it arrived would create the
 * one record that contradicts the answer, in the place someone would look to
 * check it.
 *
 * The values below are the ones a real request carries. Every assertion that
 * something was dropped is paired with one proving the fixture held it, because
 * a stripping test passes trivially against a fixture that never had the value.
 */

/** The shape Shopify documents for `customers/redact`. */
function redactRequest() {
  return {
    shop_id: 954889,
    shop_domain: 'acme.myshopify.com',
    customer: { id: 191167, email: 'shopper@example.com', phone: '555-625-1199' },
    orders_to_redact: [299938, 280263, 220458],
  }
}

/** `customers/data_request` adds the request's own id and renames the list. */
function dataRequest() {
  return {
    shop_id: 954889,
    shop_domain: 'acme.myshopify.com',
    orders_requested: [299938, 280263, 220458],
    customer: { id: 191167, email: 'shopper@example.com', phone: '555-625-1199' },
    data_request: { id: 9999 },
  }
}

const SHOPPER_VALUES = ['shopper@example.com', '555-625-1199', '191167']

describe('invariant 4 — a privacy request is stored without its shopper', () => {
  it('keeps the envelope and drops the person, on a redact request', () => {
    const stored = storableWebhookBody('customers/redact', redactRequest())

    expect(stored).toEqual({
      shop_id: 954889,
      shop_domain: 'acme.myshopify.com',
      orders_to_redact: [299938, 280263, 220458],
    })

    const serialised = JSON.stringify(stored)
    for (const value of SHOPPER_VALUES) {
      expect(serialised, `"${value}" survived`).not.toContain(value)
    }
  })

  it('does the same for a data request, whose shape differs', () => {
    const stored = storableWebhookBody('customers/data_request', dataRequest())

    expect(stored).toEqual({
      shop_id: 954889,
      shop_domain: 'acme.myshopify.com',
      orders_requested: [299938, 280263, 220458],
    })
    // The request's own id goes too: it is nested, and nothing reads it. The
    // delivery id Shopify signs the message with is what identifies this event.
    expect(stored).not.toHaveProperty('data_request')
  })

  it('is not vacuous: both fixtures really carry what was dropped', () => {
    for (const sent of [JSON.stringify(redactRequest()), JSON.stringify(dataRequest())]) {
      for (const value of SHOPPER_VALUES) {
        expect(sent, `the fixture does not contain "${value}"`).toContain(value)
      }
    }
  })

  it('drops a shopper field Shopify has not invented yet', () => {
    // The point of the allowlist. A denylist would keep this.
    const stored = storableWebhookBody('customers/redact', {
      ...redactRequest(),
      shopper_national_id: 'AB-1234',
    })
    expect(stored).not.toHaveProperty('shopper_national_id')
  })

  it('refuses an allowed key that arrives holding an object', () => {
    // How `customer` got in: a name that looks harmless over a value that grows.
    const stored = storableWebhookBody('customers/redact', {
      shop_domain: { name: 'acme.myshopify.com', owner_email: 'shopper@example.com' },
    })
    expect(JSON.stringify(stored)).not.toContain('shopper@example.com')
  })

  it('reduces shop/redact too, though it carries no person today', () => {
    // It is a privacy topic, so it goes through the same gate rather than
    // relying on Shopify never adding a field to it.
    const stored = storableWebhookBody('shop/redact', {
      shop_id: 954889,
      shop_domain: 'acme.myshopify.com',
    })
    expect(stored).toEqual({ shop_id: 954889, shop_domain: 'acme.myshopify.com' })
  })
})

describe('everything that is not a privacy request is untouched', () => {
  it('hands back a product body exactly as it arrived', () => {
    // The drain reads these, and reducing one would break catalogue sync.
    const body = { id: 700, title: 'Ridgeline Trail Shoe', variants: [{ id: 1, price: '40.00' }] }
    expect(storableWebhookBody('products/update', body)).toBe(body)
  })

  it('hands back a topic it has never heard of, rather than emptying it', () => {
    // An unknown topic is refused earlier, by the receiver. If that ever
    // changes, silently blanking the body would be the wrong failure.
    const body = { id: 1 }
    expect(storableWebhookBody('orders/create', body)).toBe(body)
  })
})

describe('the topics we deliberately do not subscribe to', () => {
  it('does not claim Shopify announces page or blog-post edits, because it does not', () => {
    // Six topics that do not exist were listed here and in the spec. Nothing
    // ever arrived on them, and the gap they hid — a merchant's page edit
    // waiting for the nightly re-read — looked like a working subscription.
    const invented = [
      'pages/create',
      'pages/update',
      'pages/delete',
      'articles/create',
      'articles/update',
      'articles/delete',
    ]
    for (const topic of invented) expect(isKnownTopic(topic)).toBe(false)
  })

  it('does not ask to be told about stock levels', () => {
    // Shopify gates that topic behind a permission over a merchant's warehouse
    // figures, which a writer of articles has no business holding. A product
    // selling out still reaches us through `products/update`.
    expect(isKnownTopic('inventory_levels/update')).toBe(false)
  })

  it('still subscribes to everything the catalogue and the connection depend on', () => {
    const needed = [
      'products/create',
      'products/update',
      'products/delete',
      'collections/create',
      'collections/update',
      'app/uninstalled',
      'shop/redact',
      'customers/redact',
      'customers/data_request',
    ]
    for (const topic of needed) expect(isKnownTopic(topic)).toBe(true)
  })
})
