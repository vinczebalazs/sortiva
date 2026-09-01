import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { deriveIdempotencyKey } from './idempotency'

const PROBE = join(dirname(fileURLToPath(import.meta.url)), 'idempotency-probe.ts')

/** Computes the key in a separate process, the way a worker restart would. */
function keyInAnotherProcess(accountId: string, step: string, inputVersion: string): string {
  return execFileSync(process.execPath, ['--import', 'tsx', PROBE, accountId, step, inputVersion], {
    encoding: 'utf8',
  })
}

/**
 * Before doing expensive work — a Shopify catalogue crawl, a batch of AI calls —
 * a worker computes a fingerprint of that work's inputs. If the job is delivered
 * again it computes the *same* fingerprint, sees the work recorded as done, and
 * returns the stored answer instead of buying it a second time.
 *
 * The property that matters is that the fingerprint survives a process restart,
 * which is exactly when a redelivery happens. The original test compared two
 * calls made back to back in one process — an assertion satisfied by any value
 * that is merely stable *within* a process (a module-level random number, the
 * process id) or within a millisecond (the wall clock). A key seeded that way
 * changes on every deploy, and every completed paid step would run again.
 */
describe('idempotency keys survive a restart (main §14.3.2)', () => {
  it('is the same value computed in a different process', () => {
    const here = deriveIdempotencyKey('acct-1', 'catalog_sync', 'gen-7')
    expect(keyInAnotherProcess('acct-1', 'catalog_sync', 'gen-7')).toBe(here)
  })

  it('is the same value computed in two different processes', () => {
    // Neither run shares memory with this test, so a per-process seed differs
    // between them even if it happened to match the one in this process.
    const first = keyInAnotherProcess('acct-1', 'distill', 'v1')
    const second = keyInAnotherProcess('acct-1', 'distill', 'v1')
    expect(first).toBe(second)
  })

  it.each([
    ['acct-1', 'catalog_sync', 'gen-7', '68e71633cf14b9214f1876b93bbde8ab80637b0d1d93983ac7f6be87e5980821'],
    ['acct-1', 'distill', 'v1', 'bf7d0cca5b4b9bc87cba8c19c5da147d3c693b3955e41777d5955d805116ac6b'],
    [
      '11111111-1111-4111-8111-111111111111',
      'persona',
      'abc',
      '7110f117cfe00616aa31e18b589a558eae63bb86f3eb8e085c04e6c68563d331',
    ],
  ])(
    'derives a fixed, published value for (%s, %s, %s)',
    (accountId, step, inputVersion, expected) => {
      // Pinned literals, not a recomputation of the same formula: a test that
      // recomputes the implementation agrees with any implementation. These fail
      // if the derivation changes at all — including by becoming random — and a
      // deliberate change to it has to change these lines too, which is the point.
      expect(deriveIdempotencyKey(accountId, step, inputVersion)).toBe(expected)
    },
  )
})
