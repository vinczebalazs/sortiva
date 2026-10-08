import { canonical, stableHash } from '../../core/hash.ts'

export { stableHash }

/**
 * Derived only from inputs, so a re-run of the same work maps to the same ledger row.
 * The readable prefix is for people reading the table; the hash is what makes it unique.
 */
export function idempotencyKey(task: string, storeId: number | null, subject: string, inputs?: unknown): string {
  const hash = stableHash([task, storeId, subject, inputs === undefined ? null : canonical(inputs)]).slice(0, 32)
  return `${task}/${storeId ?? '-'}/${subject}/${hash}`
}
