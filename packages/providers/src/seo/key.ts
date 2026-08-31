import { createHash } from 'node:crypto'

/**
 * main §14.3.6 — billable reads are cached on `(endpoint,
 * sha256(canonical_params))`, with canonicalisation defined as "sorted keys,
 * normalized locale codes". Both the live provider and the test double key on
 * this function, so the double's billable-call count means the same thing the
 * real one's does.
 */
export function seoCacheKey(endpoint: string, params: Record<string, unknown>): string {
  const canonical = JSON.stringify(canonicalise(params))
  return `dataforseo:${endpoint}:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`
}

function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise)
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
    return Object.fromEntries(entries.map(([k, v]) => [k, canonicalise(v)]))
  }
  return value
}
