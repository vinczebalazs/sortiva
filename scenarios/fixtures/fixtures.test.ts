import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PRODUCTS_PAGE } from '../../connectors/shopify/queries.ts'
import { PINNED_VERSION } from '../../fakes/fake-shopify/schema/pinned.ts'
import { startFakeShopify, type FakeShopify } from '../../fakes/fake-shopify/server.ts'
import { FIXTURE_NAMES, fixture, largeCatalog } from './index.ts'

let fake: FakeShopify
beforeAll(async () => {
  fake = await startFakeShopify({ clientId: 'c', clientSecret: 's' })
})
afterAll(() => fake?.close())

describe('fixture stores', () => {
  it('exist in pairs, one English and one Hungarian of each kind', () => {
    const kinds = new Set(FIXTURE_NAMES.map((n) => n.replace(/-(en|hu)$/, '')))
    for (const kind of kinds) expect([`${kind}-en`, `${kind}-hu`].every((n) => FIXTURE_NAMES.includes(n)), kind).toBe(true)
    expect([...kinds].sort()).toEqual(['blog', 'empty', 'fluff', 'rich', 'three'])
  })

  for (const name of [...FIXTURE_NAMES, 'large']) {
    it(`${name} loads into the fake and answers the product query`, async () => {
      const store = name === 'large' ? largeCatalog(250) : fixture(name)
      expect(store.shop.defaultLocale).toBe(name.endsWith('-hu') ? 'hu' : 'en')
      fake.addShop(store)
      const domain = store.shop.myshopifyDomain
      const tokenRes = await fetch(`${fake.baseUrlFor(domain)}/admin/oauth/access_token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'c', client_secret: 's',
          grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
          subject_token: fake.mintSessionToken(domain),
          subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
        }),
      })
      const { access_token } = (await tokenRes.json()) as { access_token: string }
      const res = await fetch(`${fake.baseUrlFor(domain)}/admin/api/${PINNED_VERSION}/graphql.json`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-shopify-access-token': access_token },
        body: JSON.stringify({ query: PRODUCTS_PAGE, variables: { first: 5 } }),
      })
      const body = (await res.json()) as any
      expect(body.errors).toBeUndefined()
      expect(body.data.products.nodes.length).toBe(Math.min(5, store.products.length))
    })
  }
})
