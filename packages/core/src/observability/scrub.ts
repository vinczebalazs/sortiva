/**
 * Tokens never appear in logs, analytics events or error reports, and events
 * carry ids and aggregates only.
 *
 * Two mechanisms, because either alone leaks:
 *
 * 1. **Shape and key matching** catches secrets nobody registered: a value under
 *    a key like `access_token`, or a string carrying a recognisable vendor token
 *    prefix.
 * 2. **Registered literals** catch the rest. Anything read from the environment
 *    at startup (`registerSecret`) is redacted wherever it appears, including
 *    mid-sentence in an exception message, where no key name exists to match on.
 */

export const REDACTED = '[redacted]'

/** Substring-matched, case-insensitively, against object keys. */
const SECRET_KEY_PARTS = [
  'token',
  'secret',
  'password',
  'passwd',
  'apikey',
  'api_key',
  'authorization',
  'auth',
  'cookie',
  'credential',
  'private_key',
  'encryption_key',
  'signature',
  'hmac',
]

/**
 * Vendor token shapes. Each is anchored on a prefix the vendor documents, so a
 * plain sentence cannot trip it.
 *   shpat_/shpss_/shpca_  Shopify access, shared-secret, custom-app tokens
 *   sk-ant-               Anthropic API keys
 *   sk_live_/sk_test_/rk_ Stripe secret and restricted keys
 *   whsec_                Stripe webhook signing secrets
 *   re_                   Resend API keys
 *   phx_                  PostHog personal API keys
 *   ya29./1//             Google OAuth access and refresh tokens
 *   eyJ...                JWTs (three base64url segments)
 */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /shp(at|ss|ca)_[A-Za-z0-9]{16,}/g,
  /sk-ant-[A-Za-z0-9_-]{16,}/g,
  /\b(sk|rk)_(live|test)_[A-Za-z0-9]{16,}/g,
  /\bwhsec_[A-Za-z0-9]{16,}/g,
  /\bre_[A-Za-z0-9_-]{16,}/g,
  /\bphx_[A-Za-z0-9_-]{16,}/g,
  /\bya29\.[A-Za-z0-9_-]{16,}/g,
  /\b1\/\/[A-Za-z0-9_-]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
]

const registered = new Set<string>()

/**
 * Registers a literal secret so it is redacted wherever it appears. Call at
 * startup for every secret read from the environment. Values shorter than 8
 * characters are ignored: redacting a short string would corrupt unrelated
 * output far more often than it would protect anything.
 */
export function registerSecret(value: string | undefined | null): void {
  if (typeof value === 'string' && value.length >= 8) registered.add(value)
}

/** Test-only: drops the registry so one test's secret cannot affect another's. */
export function resetRegisteredSecrets(): void {
  registered.clear()
}

export function scrubString(input: string): string {
  let out = input
  for (const secret of registered) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED)
  }
  for (const pattern of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, REDACTED)
  }
  return out
}

function keyLooksSecret(key: string): boolean {
  const normalised = key.toLowerCase().replace(/[^a-z_]/g, '')
  return SECRET_KEY_PARTS.some((part) => normalised.includes(part.replace(/[^a-z_]/g, '')))
}

/**
 * Recursively redacts a value. Cycles are replaced with `[circular]` rather than
 * throwing — a scrubber that can crash the exception path is worse than useless.
 */
export function scrub<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value === 'string') return scrubString(value) as unknown as T
  if (value === null || typeof value !== 'object') return value

  if (seen.has(value as object)) return '[circular]' as unknown as T
  seen.add(value as object)

  if (Array.isArray(value)) {
    return value.map((item) => scrub(item, seen)) as unknown as T
  }

  if (value instanceof Error) {
    const copy = new Error(scrubString(value.message))
    copy.name = value.name
    if (value.stack) copy.stack = scrubString(value.stack)
    return copy as unknown as T
  }

  if (value instanceof Date) return value

  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = keyLooksSecret(key) ? REDACTED : scrub(item, seen)
  }
  return out as unknown as T
}
