import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installKillSwitchReader, resetKillSwitchReader } from './gate'
import { withAccountLock, tryWithAccountLock } from './lock'
import { clearTasks, registerTask, taskList } from './tasks'

/**
 * All work for one store runs one thing at a time. That is what stops the
 * nightly sweep, an incoming webhook and a merchant pressing "re-sync" from
 * writing the same rows at once — and until now six workers took that lock by
 * hand while nothing would have noticed a seventh that forgot.
 *
 * Registering a job already wraps it in the kill-switch check, on the reasoning
 * that a switch half the code paths consult is not a switch. These cases hold
 * the same promise for the lock: a job declares whether it works on one
 * account's data, and the runtime fails it if it finishes without asking.
 *
 * They run against the registry the deployed worker uses, not a copy of its
 * logic, because the guard that this replaces existed and could not fire.
 */

// With no kill-switch reader the registry runs handlers unwrapped, which is
// what these cases want: they are about the lock, and a paused job never
// reaches the lock check at all. That ordering has its own case at the bottom.

const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'

/**
 * A pool that hands back a client answering the two statements the lock makes,
 * and nothing else. Enough to exercise acquisition without a database: what is
 * under test is the registry's bookkeeping, not Postgres's advisory locks,
 * which `runtime.test.ts` covers against a real server.
 */
function fakePool(options: { acquired?: boolean } = {}) {
  const acquired = options.acquired ?? true
  return {
    connect: async () => ({
      query: async (sql: string) => {
        if (sql.includes('hashtextextended')) return { rows: [{ key: '42' }] }
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired }] }
        if (sql.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }] }
        return { rows: [] }
      },
      release: () => {},
    }),
  } as never
}

const run = async (name: string, payload: unknown): Promise<unknown> => {
  const handler = taskList()[name] as (payload: unknown, helpers: unknown) => Promise<unknown>
  return handler(payload, { logger: { error: () => {} } })
}

describe('a job that works on one store must ask for its lock', () => {
  beforeEach(() => {
    clearTasks()
    resetKillSwitchReader()
  })
  afterEach(() => clearTasks())

  it('lets through a job that took the lock on the account it was given', async () => {
    const pool = fakePool()
    let did = false
    registerTask(
      'takes_the_lock',
      async (payload) => {
        await withAccountLock(pool, (payload as { accountId: string }).accountId, async () => {
          did = true
        })
      },
      'per_account',
    )

    await run('takes_the_lock', { accountId: ACCOUNT })
    expect(did).toBe(true)
  })

  it('fails a job that did the work without asking, and names the account', async () => {
    registerTask('forgot_the_lock', async () => {}, 'per_account')

    await expect(run('forgot_the_lock', { accountId: ACCOUNT })).rejects.toThrow(
      /forgot_the_lock.*without asking for the account lock on 11111111/s,
    )
  })

  /**
   * The failure that matters is not "no lock" but "the wrong one": two jobs
   * writing one store's rows at once is what this exists to stop, and a job
   * that locked somebody else has not stopped it.
   */
  it('fails a job that locked a different account from the one it was given', async () => {
    const pool = fakePool()
    registerTask(
      'locks_the_wrong_store',
      async () => {
        await withAccountLock(pool, OTHER, async () => {})
      },
      'per_account',
    )

    await expect(run('locks_the_wrong_store', { accountId: ACCOUNT })).rejects.toThrow(
      /without asking for the account lock on 11111111/,
    )
  })

  /**
   * `tryWithAccountLock` returns without running its body when another worker
   * already holds the account. Backing off is correct behaviour, not a skipped
   * lock — three jobs in this repository rely on it — so the runtime records
   * the *attempt*, not the acquisition. Demanding acquisition would fail these
   * jobs for doing exactly the right thing, every time the queue was busy.
   */
  it('lets through a job that asked, found the store busy, and backed off', async () => {
    const pool = fakePool({ acquired: false })
    let ran = false
    registerTask(
      'backs_off',
      async (payload) => {
        await tryWithAccountLock(pool, (payload as { accountId: string }).accountId, async () => {
          ran = true
        })
      },
      'per_account',
    )

    await run('backs_off', { accountId: ACCOUNT })
    expect(ran, 'the body must not have run — the account was held elsewhere').toBe(false)
  })

  it('refuses a job declared per-account whose payload names no account', async () => {
    registerTask('no_account_in_payload', async () => {}, 'per_account')

    await expect(run('no_account_in_payload', {})).rejects.toThrow(/names no account/)
  })

  /**
   * The email sender is handed a message id and reads the account off the
   * record, so the runtime cannot know which account was meant. It checks that
   * a lock was asked for and says in the type that it cannot check which —
   * weaker than the case above, stronger than nothing.
   */
  it('accepts an account discovered inside the job, and still fails one that asks for nothing', async () => {
    const pool = fakePool()
    let sent = false
    registerTask(
      'reads_its_account',
      async () => {
        await withAccountLock(pool, OTHER, async () => {
          sent = true
        })
      },
      'account_from_record',
    )
    registerTask('reads_nothing', async () => {}, 'account_from_record')

    await run('reads_its_account', { emailSendId: 'e1' })
    expect(sent).toBe(true)
    await expect(run('reads_nothing', { emailSendId: 'e1' })).rejects.toThrow(
      /without asking for the account lock/,
    )
  })

  /**
   * Stated as a test rather than a comment, so nobody reads the mechanism as
   * covering more than it does. A sweep that walks every account looks
   * identical from outside whether it locked all of them or none, so it is not
   * checked at all — and neither is a job that touches no account.
   */
  it('does not check a sweep that fans out, or a job with no account at all', async () => {
    const touched: string[] = []
    registerTask('fans_out_unchecked', async () => { touched.push('sweep') }, 'fans_out')
    registerTask('no_accounts_at_all', async () => { touched.push('global') }, 'none')

    await run('fans_out_unchecked', {})
    await run('no_accounts_at_all', {})
    expect(touched, 'neither was refused for taking no lock').toEqual(['sweep', 'global'])
  })

  /**
   * The ordering the mechanism depends on. A job the kill switches have paused
   * returns having done nothing, and therefore takes no lock — so a check that
   * sat *outside* the gate would report every paused job as a lock violation,
   * and the first operator to pause the product would be handed a flood of
   * failures saying its jobs were racing each other.
   */
  it('does not accuse a job the kill switches paused', async () => {
    // A reader whose database answers nothing: the gate treats an unreadable
    // switch as "stop", which is the same path a raised switch takes.
    installKillSwitchReader(() => ({}) as never)
    let ran = false
    registerTask('paused_before_it_could_lock', async () => { ran = true }, 'per_account')

    await expect(run('paused_before_it_could_lock', { accountId: ACCOUNT })).resolves.toBeUndefined()
    expect(ran, 'the handler must not have run at all').toBe(false)
  })

  it('hands the job the helpers argument, which a wrapper is easy to drop', async () => {
    const pool = fakePool()
    let sawHelpers = false
    registerTask(
      'needs_helpers',
      async (payload, helpers) => {
        sawHelpers = Boolean(helpers)
        await withAccountLock(pool, (payload as { accountId: string }).accountId, async () => {})
      },
      'per_account',
    )

    await run('needs_helpers', { accountId: ACCOUNT })
    expect(sawHelpers, 'a job that re-queues itself needs the helpers Graphile passes').toBe(true)
  })
})
