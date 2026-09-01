import { afterEach, describe, expect, it } from 'vitest'
import { REDACTED, registerSecret, resetRegisteredSecrets, scrub, scrubString } from './scrub'
import { createLogger } from './logger'

/**
 * T0.5 done-when: "scrubber test proves a token never reaches log output".
 * Tokens never appear in logs, analytics events or error reports.
 */

const SHOPIFY_TOKEN = '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'
const GOOGLE_REFRESH = '1//0gL9xQnT4rEXAMPLEreFReshTokenValue'

afterEach(() => {
  resetRegisteredSecrets()
})

describe('scrubber', () => {
  it('redacts vendor token shapes nobody registered', () => {
    expect(scrubString(`store token is ${SHOPIFY_TOKEN} ok`)).toBe(`store token is ${REDACTED} ok`)
    expect(scrubString(`refresh ${GOOGLE_REFRESH}`)).toBe(`refresh ${REDACTED}`)
    expect(scrubString('sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZ')).toBe(REDACTED)
    expect(scrubString('whsec_abcdefghijklmnopqrstuvwxyz')).toBe(REDACTED)
  })

  it('leaves ordinary prose alone', () => {
    const line = 'Synced 412 products for example.com in 1.8s'
    expect(scrubString(line)).toBe(line)
  })

  it('redacts values under secret-looking keys whatever their shape', () => {
    const scrubbed = scrub({
      shop: 'example.myshopify.com',
      access_token: 'plain-looking-but-still-a-token',
      nested: { authorization: 'Basic abc', productCount: 412 },
    })
    expect(scrubbed).toEqual({
      shop: 'example.myshopify.com',
      access_token: REDACTED,
      nested: { authorization: REDACTED, productCount: 412 },
    })
  })

  it('redacts a registered secret wherever it appears, including mid-sentence', () => {
    registerSecret('correct-horse-battery-staple')
    expect(scrubString('connecting with correct-horse-battery-staple now')).toBe(
      `connecting with ${REDACTED} now`,
    )
  })

  it('ignores short registered values, which would corrupt unrelated output', () => {
    registerSecret('abc')
    expect(scrubString('abc is fine')).toBe('abc is fine')
  })

  it('scrubs error messages and stacks on the exception path', () => {
    const error = new Error(`Shopify rejected token ${SHOPIFY_TOKEN}`)
    const scrubbed = scrub(error) as Error
    expect(scrubbed.message).not.toContain(SHOPIFY_TOKEN)
    expect(scrubbed.stack ?? '').not.toContain(SHOPIFY_TOKEN)
  })

  it('survives a cycle rather than throwing on the exception path', () => {
    const node: Record<string, unknown> = { name: 'a' }
    node.self = node
    expect(scrub(node)).toEqual({ name: 'a', self: '[circular]' })
  })

  it('never lets a token reach log output — message, field, or nested field', () => {
    const lines: string[] = []
    const log = createLogger({ sink: (line) => lines.push(line), minLevel: 'debug' })
    registerSecret('a-registered-plaintext-secret')

    log.info(`refreshing with ${SHOPIFY_TOKEN}`, {
      accessToken: SHOPIFY_TOKEN,
      conn: { refresh_token: GOOGLE_REFRESH, shop: 'example.myshopify.com' },
      note: 'value is a-registered-plaintext-secret',
    })
    log.error('sync failed', { err: new Error(`bad token ${SHOPIFY_TOKEN}`) })

    const output = lines.join('\n')
    expect(output).not.toContain(SHOPIFY_TOKEN)
    expect(output).not.toContain(GOOGLE_REFRESH)
    expect(output).not.toContain('a-registered-plaintext-secret')
    // The non-secret context is still there — a scrubber that redacts
    // everything is a scrubber nobody will keep using.
    expect(output).toContain('example.myshopify.com')
    expect(output).toContain('sync failed')
  })
})
