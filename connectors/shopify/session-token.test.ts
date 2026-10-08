import { afterAll, beforeAll, expect, it } from 'vitest'
import { startFakeShopify, type FakeShopify } from '../../fakes/fake-shopify/server.ts'
import { verifySessionToken } from './session-token.ts'

let fake: FakeShopify
beforeAll(async () => {
  fake = await startFakeShopify({ clientId: 'app-id', clientSecret: 'app-secret' })
})
afterAll(() => fake?.close())

it('accepts a token App Bridge would issue for our app and names the shop', () => {
  expect(verifySessionToken(fake.mintSessionToken('a-shop.myshopify.com'), 'app-id', 'app-secret')).toMatchObject({ shopDomain: 'a-shop.myshopify.com' })
})

it('refuses an expired token, a token for another app, and a forged signature', () => {
  expect(verifySessionToken(fake.mintSessionToken('a-shop.myshopify.com', { expiresInSeconds: -60 }), 'app-id', 'app-secret')).toBeNull()
  expect(verifySessionToken(fake.mintSessionToken('a-shop.myshopify.com'), 'other-app', 'app-secret')).toBeNull()
  expect(verifySessionToken(fake.mintSessionToken('a-shop.myshopify.com', { secret: 'wrong' }), 'app-id', 'app-secret')).toBeNull()
  expect(verifySessionToken('not.a.token', 'app-id', 'app-secret')).toBeNull()
})
