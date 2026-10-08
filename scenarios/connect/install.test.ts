import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startPipeline, type Pipeline } from '../pipeline.ts'

let p: Pipeline
beforeAll(async () => {
  p = await startPipeline()
})
afterAll(() => p?.stop())

describe('installing a store', () => {
  it('creates the store from Shopify, keeps its tokens encrypted, and reads the catalogue', async () => {
    const store = await p.install('rich-hu')
    await p.settle()

    const { rows } = await p.db.pool.query('select * from stores where id = $1', [store.id])
    const row = rows[0]
    expect(row).toMatchObject({
      shop_domain: 'bukki-fuveshaz.myshopify.com',
      storefront_host: 'bukkifuveshaz.hu',
      primary_locale: 'hu',
      country: 'HU',
      timezone: 'Europe/Budapest',
      delivery_mode: 'export',
      setup_step: 'profile',
    })
    expect(row.scopes.sort()).toEqual(['read_content', 'read_products', 'write_content'])
    expect(row.access_token_enc).not.toMatch(/shpat_/)
    expect(row.refresh_token_enc).not.toMatch(/shprt_/)
    expect(row.access_token_expires_at.getTime()).toBeGreaterThan(Date.now() + 50 * 60_000)

    const products = await p.db.pool.query('select count(*)::int as n from products where store_id = $1 and deleted_at is null', [store.id])
    expect(products.rows[0].n).toBe(12)
    const profile = await p.db.pool.query('select language, country, confirmed_at from store_profile where store_id = $1', [store.id])
    expect(profile.rows[0]).toMatchObject({ language: 'hu', country: 'HU', confirmed_at: null })
  })

  it('reinstalling the same shop reuses the store instead of creating another', async () => {
    const again = await p.install('rich-hu', { alreadyLoaded: true })
    const { rows } = await p.db.pool.query(`select count(*)::int as n from stores where shop_domain = 'bukki-fuveshaz.myshopify.com'`)
    expect(rows[0].n).toBe(1)
    expect(again.id).toBe((await p.storeId('bukki-fuveshaz.myshopify.com')))
  })

  it('refreshes a token past its expiry before the first call, without Shopify ever seeing the dead token', async () => {
    const store = await p.install('three-en')
    await p.settle()
    p.shopify.expireAccessTokens(store.domain)
    await p.db.pool.query(`update stores set access_token_expires_at = now() - interval '1 minute' where id = $1`, [store.id])
    const before = p.shopify.unauthorized
    const refreshesBefore = p.shopify.tokenRequests.filter((t) => t.grantType === 'refresh_token').length

    expect(await p.syncNow(store.id)).toBe('started')
    await p.settle()

    expect(p.shopify.unauthorized).toBe(before)
    expect(p.shopify.tokenRequests.filter((t) => t.grantType === 'refresh_token').length).toBe(refreshesBefore + 1)
    const { rows } = await p.db.pool.query('select access_token_expires_at from stores where id = $1', [store.id])
    expect(rows[0].access_token_expires_at.getTime()).toBeGreaterThan(Date.now())
  })

  it('a refused permission pauses the store with the permission named, and never disconnects it', async () => {
    const store = await p.install('three-hu')
    await p.settle()
    p.shopify.revokeScope(store.domain, 'read_products')

    await p.syncNow(store.id)
    await p.settle()

    const flags = await p.db.pool.query('select permissions_lost from store_flags where store_id = $1', [store.id])
    expect(flags.rows[0].permissions_lost).toEqual(['read_products'])
    const row = await p.db.pool.query('select closed_at, access_token_enc from stores where id = $1', [store.id])
    expect(row.rows[0].closed_at).toBeNull()
    expect(row.rows[0].access_token_enc).not.toBeNull()
    expect((await p.banners(store.id)).map((b) => b.kind)).toContain('permission_lost')

    p.shopify.shop(store.domain).grantedScopes.push('read_products')
    await p.syncNow(store.id)
    await p.settle()
    const after = await p.db.pool.query('select permissions_lost from store_flags where store_id = $1', [store.id])
    expect(after.rows[0].permissions_lost).toEqual([])
  })
})
