import { createHash } from 'node:crypto'
import type { JobStepName } from './steps'

/**
 * NUL separator. Without one, ("ab", "c") and ("a", "bc") concatenate to the
 * same string — a real hazard when input versions are themselves concatenated
 * ids. Written as an escape, never as a literal control byte in the source.
 */
const SEP = '\u0000'

/**
 * Keys are computed from inputs and never random, so a retry of the same work
 * arrives at the same key and the ledger can recognise it:
 *
 *   idempotency_key = sha256(account_id + step_name + input_version)
 *
 * `input_version` is step-specific and supplied by the step's owning card:
 * `catalog_sync` uses the Shopify shop id + sync generation; `distill` the
 * product's `updated_at` + body checksum; `family_group` the sorted set of
 * member `product_facts.distilled_at`; `persona` / `keywords_competitors` a
 * hash of their upstream artefacts.
 */
export function deriveIdempotencyKey(
  accountId: string,
  step: JobStepName | string,
  inputVersion: string,
): string {
  if (!accountId || !step || !inputVersion) {
    throw new Error('deriveIdempotencyKey requires accountId, step and a non-empty inputVersion')
  }
  return createHash('sha256').update([accountId, step, inputVersion].join(SEP)).digest('hex')
}

/**
 * Builds a stable `input_version` from an arbitrary set of inputs. Keys are
 * sorted and values JSON-encoded, so property order in the caller cannot change
 * the key — the same canonicalisation the vendor cache keys use.
 */
export function inputVersion(parts: Record<string, unknown>): string {
  const canonical = Object.keys(parts)
    .sort()
    .map((key) => `${key}=${JSON.stringify(parts[key] ?? null)}`)
    .join(SEP)
  return createHash('sha256').update(canonical).digest('hex')
}
