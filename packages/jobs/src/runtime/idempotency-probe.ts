/**
 * Prints one idempotency key and exits. Run as its own process by
 * `idempotency.test.ts`, because the property that matters — the same inputs
 * give the same key *after a restart* — cannot be observed from inside a single
 * process. A key seeded with anything stable-per-process (a module-level random
 * value, the process id) agrees with itself perfectly and is still worthless.
 */
import { deriveIdempotencyKey } from './idempotency'

const [, , accountId, step, inputVersion] = process.argv
process.stdout.write(deriveIdempotencyKey(accountId!, step!, inputVersion!))
