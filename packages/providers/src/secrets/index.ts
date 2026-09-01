import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'
import { registerSecret } from '@sortiva/core'

/**
 * tech §4 — "application-layer envelope encryption: per-row data key, wrapped by
 * a master key in the platform KMS (or `age` key in the deploy secret store for
 * v1). Decryption only in the worker/API process at point of use."
 *
 * Envelope rather than encrypting with the master key directly, for one
 * practical reason: rotating the master key then means re-wrapping a short key
 * per row instead of re-encrypting every stored token — and each row's plaintext
 * is protected by a key used exactly once.
 *
 * Stored form (one string, so it fits a text column):
 *
 *   v1.<masterKeyId>.<wrappedDataKey>.<wrapIv>.<wrapTag>.<iv>.<tag>.<ciphertext>
 *
 * `masterKeyId` is a short fingerprint of the master key, so a value encrypted
 * under a retired key is decrypted with the right key rather than by trial.
 */

const VERSION = 'v1'
const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32
const IV_BYTES = 12

export class EncryptionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions)
    this.name = 'EncryptionError'
  }
}

export interface MasterKey {
  readonly id: string
  readonly key: Buffer
}

function parseMasterKey(raw: string, label: string): MasterKey {
  const key = Buffer.from(raw.trim(), 'base64')
  if (key.length !== KEY_BYTES) {
    throw new EncryptionError(
      `${label} must be ${KEY_BYTES} bytes base64-encoded (generate: openssl rand -base64 32); got ${key.length}.`,
    )
  }
  return { id: createHash('sha256').update(key).digest('hex').slice(0, 8), key }
}

export interface TokenCipherOptions {
  master?: string
  /** Comma-separated retired keys, newest first. Decrypt-only. */
  previous?: string
  env?: NodeJS.ProcessEnv
}

/**
 * Encrypts with the current master key; decrypts with whichever key the stored
 * value names. Retired keys stay readable, so rotation is a deploy rather than a
 * migration.
 */
export class TokenCipher {
  private readonly current: MasterKey
  private readonly all = new Map<string, MasterKey>()

  constructor(options: TokenCipherOptions = {}) {
    const env = options.env ?? process.env
    const master = options.master ?? env.ENCRYPTION_MASTER_KEY
    if (!master) {
      throw new EncryptionError(
        'ENCRYPTION_MASTER_KEY is not set. Tokens are encrypted at rest (tech §4); refusing to start without the key.',
      )
    }
    this.current = parseMasterKey(master, 'ENCRYPTION_MASTER_KEY')
    this.all.set(this.current.id, this.current)

    const previous = options.previous ?? env.ENCRYPTION_MASTER_KEY_PREVIOUS ?? ''
    const retired = previous.split(',').map((v) => v.trim()).filter(Boolean)
    for (const raw of retired) {
      const key = parseMasterKey(raw, 'ENCRYPTION_MASTER_KEY_PREVIOUS')
      if (!this.all.has(key.id)) this.all.set(key.id, key)
    }

    // Registering them means a master key that somehow reaches a log line or an
    // exception message is redacted (tech §4, scrubber).
    registerSecret(master)
    for (const raw of retired) registerSecret(raw)
  }

  encrypt(plaintext: string): string {
    const dataKey = randomBytes(KEY_BYTES)
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv(ALGORITHM, dataKey, iv)
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()

    const wrapIv = randomBytes(IV_BYTES)
    const wrapper = createCipheriv(ALGORITHM, this.current.key, wrapIv)
    const wrapped = Buffer.concat([wrapper.update(dataKey), wrapper.final()])
    const wrapTag = wrapper.getAuthTag()

    // The data key exists only inside this call; nothing else ever holds it.
    dataKey.fill(0)

    return [
      VERSION,
      this.current.id,
      wrapped.toString('base64'),
      wrapIv.toString('base64'),
      wrapTag.toString('base64'),
      iv.toString('base64'),
      tag.toString('base64'),
      ciphertext.toString('base64'),
    ].join('.')
  }

  decrypt(stored: string): string {
    const parts = stored.split('.')
    if (parts.length !== 8 || parts[0] !== VERSION) {
      throw new EncryptionError('Stored value is not a v1 envelope-encrypted token.')
    }
    const [, keyId, wrapped, wrapIv, wrapTag, iv, tag, ciphertext] = parts as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ]

    const master = this.all.get(keyId)
    if (!master) {
      throw new EncryptionError(
        `No master key with fingerprint ${keyId} is loaded. Add the retired key to ENCRYPTION_MASTER_KEY_PREVIOUS.`,
      )
    }

    let dataKey: Buffer
    try {
      const unwrapper = createDecipheriv(ALGORITHM, master.key, Buffer.from(wrapIv, 'base64'))
      unwrapper.setAuthTag(Buffer.from(wrapTag, 'base64'))
      dataKey = Buffer.concat([
        unwrapper.update(Buffer.from(wrapped, 'base64')),
        unwrapper.final(),
      ])
    } catch (error) {
      throw new EncryptionError(
        'Data key failed authentication — wrong master key, or the row was tampered with.',
        { cause: error },
      )
    }

    try {
      const decipher = createDecipheriv(ALGORITHM, dataKey, Buffer.from(iv, 'base64'))
      decipher.setAuthTag(Buffer.from(tag, 'base64'))
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8')
      // Now that a real token is in memory, make sure it can never be logged.
      registerSecret(plaintext)
      return plaintext
    } catch (error) {
      throw new EncryptionError('Token failed authentication — the stored row was altered.', {
        cause: error,
      })
    } finally {
      dataKey.fill(0)
    }
  }

  /** True when the value was encrypted under a key that is no longer current. */
  needsRewrap(stored: string): boolean {
    return stored.split('.')[1] !== this.current.id
  }
}

/**
 * Constant-time comparison for webhook signatures (Shopify HMAC, Resend, Stripe).
 * `===` on a signature leaks its prefix through timing; this does not.
 */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/** A URL carrying `user:password@` — a database or broker connection string. */
const CONNECTION_STRING = /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]*:[^/@\s]+@/i

/**
 * Registers every secret-shaped environment variable with the log scrubber.
 * Called once at process start, so a secret that reaches a log line or an
 * exception message is redacted wherever it appears (tech §4).
 *
 * Two families qualify. **Secret-shaped names** — anything ending in SECRET,
 * TOKEN, PASSWORD, API_KEY or KEY. **Connection strings** — audit
 * `docs/audits/T0.5.md` finding 14: `DATABASE_URL` matches none of those
 * suffixes and carries a password inline, so a Postgres error that echoed the
 * connection string printed it. Matching on the *value* rather than adding
 * `URL$` to the name pattern is what keeps `APP_URL` readable in logs, which is
 * where it belongs.
 */
export function registerEnvSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  const registered: string[] = []
  for (const [name, value] of Object.entries(env)) {
    if (!value) continue
    const secretName = /(SECRET|TOKEN|PASSWORD|API_KEY|KEY)$/.test(name)
    if (!secretName && !CONNECTION_STRING.test(value)) continue
    // A publishable key or a Turnstile site key belongs in logs; registering it
    // would redact values that are meant to be readable.
    if (/PUBLIC|SITE_KEY|PROJECT_ID/.test(name)) continue
    registerSecret(value)
    registered.push(name)
  }
  return registered
}
