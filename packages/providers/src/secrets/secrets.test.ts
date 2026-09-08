import { afterEach, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { REDACTED, resetRegisteredSecrets, scrubString } from '@sortiva/core'
import { EncryptionError, TokenCipher, registerEnvSecrets, safeEqual } from './index'

/** Token encryption at rest, key rotation, and the log scrubber. */

const KEY_A = randomBytes(32).toString('base64')
const KEY_B = randomBytes(32).toString('base64')
const SHOPIFY_TOKEN = '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'

afterEach(() => {
  resetRegisteredSecrets()
})

describe('TokenCipher', () => {
  it('round-trips a token', () => {
    const cipher = new TokenCipher({ master: KEY_A })
    const stored = cipher.encrypt(SHOPIFY_TOKEN)
    expect(stored).not.toContain(SHOPIFY_TOKEN)
    expect(cipher.decrypt(stored)).toBe(SHOPIFY_TOKEN)
  })

  it('uses a fresh data key per row, so two rows of the same token differ', () => {
    const cipher = new TokenCipher({ master: KEY_A })
    expect(cipher.encrypt(SHOPIFY_TOKEN)).not.toBe(cipher.encrypt(SHOPIFY_TOKEN))
  })

  it('rejects a tampered ciphertext instead of returning garbage', () => {
    const cipher = new TokenCipher({ master: KEY_A })
    const stored = cipher.encrypt(SHOPIFY_TOKEN)
    const parts = stored.split('.')
    parts[7] = Buffer.from('tampered-ciphertext-value').toString('base64')
    expect(() => cipher.decrypt(parts.join('.'))).toThrow(EncryptionError)
  })

  it('reads rows written under a retired key, and flags them for re-wrapping', () => {
    const old = new TokenCipher({ master: KEY_A })
    const stored = old.encrypt(SHOPIFY_TOKEN)

    const rotated = new TokenCipher({ master: KEY_B, previous: KEY_A })
    expect(rotated.decrypt(stored)).toBe(SHOPIFY_TOKEN)
    expect(rotated.needsRewrap(stored)).toBe(true)
    expect(rotated.needsRewrap(rotated.encrypt(SHOPIFY_TOKEN))).toBe(false)
  })

  it('names the missing key when a retired one was not loaded', () => {
    const old = new TokenCipher({ master: KEY_A })
    const stored = old.encrypt(SHOPIFY_TOKEN)
    const rotated = new TokenCipher({ master: KEY_B })
    expect(() => rotated.decrypt(stored)).toThrow(/ENCRYPTION_MASTER_KEY_PREVIOUS/)
  })

  it('refuses to start without a master key', () => {
    expect(() => new TokenCipher({ env: {} })).toThrow(/ENCRYPTION_MASTER_KEY is not set/)
  })

  it('rejects a master key of the wrong length rather than deriving one', () => {
    expect(() => new TokenCipher({ master: 'dG9vLXNob3J0' })).toThrow(/must be 32 bytes/)
  })

  it('registers the master key with the scrubber, so it cannot be logged', () => {
    // Constructing it is the registration.
    void new TokenCipher({ master: KEY_A })
    expect(scrubString(`starting with key ${KEY_A}`)).toBe(`starting with key ${REDACTED}`)
  })

  it('registers a decrypted token, so a later log line cannot leak it', () => {
    const cipher = new TokenCipher({ master: KEY_A })
    const plain = 'a-token-with-no-recognisable-vendor-prefix'
    const stored = cipher.encrypt(plain)
    expect(scrubString(`using ${plain}`)).toBe(`using ${plain}`)
    cipher.decrypt(stored)
    expect(scrubString(`using ${plain}`)).toBe(`using ${REDACTED}`)
  })
})

describe('registerEnvSecrets', () => {
  it('registers secret-shaped variables and skips public ones', () => {
    const registered = registerEnvSecrets({
      STRIPE_SECRET_KEY: 'sk_test_thisisalongenoughvalue',
      TURNSTILE_SITE_KEY: '0x4AAAAAAApublicvalue',
      POSTHOG_PROJECT_ID: '12345',
      APP_URL: 'http://localhost:3000',
      DATAFORSEO_PASSWORD: 'a-long-vendor-password',
    })

    expect(registered.sort()).toEqual(['DATAFORSEO_PASSWORD', 'STRIPE_SECRET_KEY'])
    expect(scrubString('with a-long-vendor-password')).toBe(`with ${REDACTED}`)
    expect(scrubString('site 0x4AAAAAAApublicvalue')).toBe('site 0x4AAAAAAApublicvalue')
  })

  it('registers a connection string, whose name matches no secret suffix', () => {
    // a Postgres error that echoes the
    // connection string used to print the password with it.
    const registered = registerEnvSecrets({
      DATABASE_URL: 'postgres://sortiva:s3cr3t@db.internal:5432/sortiva',
      APP_URL: 'https://app.sortiva.com',
    })

    expect(registered).toEqual(['DATABASE_URL'])
    expect(scrubString('connect to postgres://sortiva:s3cr3t@db.internal:5432/sortiva failed')).toBe(
      `connect to ${REDACTED} failed`,
    )
    // A URL with no credentials in it is not a secret, and stays readable.
    expect(scrubString('serving https://app.sortiva.com')).toBe('serving https://app.sortiva.com')
  })
})

describe('safeEqual', () => {
  it('compares signatures without leaking length or prefix through `===`', () => {
    expect(safeEqual('abcdef', 'abcdef')).toBe(true)
    expect(safeEqual('abcdef', 'abcdeg')).toBe(false)
    expect(safeEqual('abc', 'abcdef')).toBe(false)
  })
})
