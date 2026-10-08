import { createHash } from 'node:crypto'

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    )
  }
  return value
}

export function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

/**
 * Derived only from inputs, so a re-run of the same work maps to the same ledger row.
 * The readable prefix is for people reading the table; the hash is what makes it unique.
 */
export function idempotencyKey(task: string, storeId: number | null, subject: string, inputs?: unknown): string {
  const hash = stableHash([task, storeId, subject, inputs === undefined ? null : canonical(inputs)]).slice(0, 32)
  return `${task}/${storeId ?? '-'}/${subject}/${hash}`
}
