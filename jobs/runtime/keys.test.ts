import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { idempotencyKey } from './keys.ts'

describe('idempotency keys', () => {
  it('derives the same key from the same inputs', () => {
    expect(idempotencyKey('write', 7, '2026-10-08', { topic: 3 })).toBe(idempotencyKey('write', 7, '2026-10-08', { topic: 3 }))
  })

  it('separates tasks, stores, subjects and inputs', () => {
    const base = idempotencyKey('write', 7, 'd', { a: 1 })
    expect(new Set([
      base,
      idempotencyKey('deliver', 7, 'd', { a: 1 }),
      idempotencyKey('write', 8, 'd', { a: 1 }),
      idempotencyKey('write', 7, 'e', { a: 1 }),
      idempotencyKey('write', 7, 'd', { a: 2 }),
    ]).size).toBe(5)
  })

  it('cannot be collided by moving text between parts', () => {
    expect(idempotencyKey('ab', 1, 'c')).not.toBe(idempotencyKey('a', 1, 'bc'))
  })

  it('ignores property order in the inputs', () => {
    expect(idempotencyKey('t', 1, 's', { a: 1, b: { c: 2, d: 3 } })).toBe(idempotencyKey('t', 1, 's', { b: { d: 3, c: 2 }, a: 1 }))
  })

  it('is the same in another process, so a restart maps to the same ledger row', () => {
    const script = `import { idempotencyKey } from './jobs/runtime/keys.ts'; process.stdout.write(idempotencyKey('write', 7, 'd', { x: [1, 2] }))`
    const other = execFileSync('npx', ['tsx', '-e', script], { encoding: 'utf8' })
    expect(other).toBe(idempotencyKey('write', 7, 'd', { x: [1, 2] }))
  })
})
