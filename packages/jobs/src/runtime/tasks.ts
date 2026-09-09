import type { Task, TaskList } from 'graphile-worker'
import { guardedTask } from './gate'
import { recordingAccountLocks } from './lock'

/**
 * The task registry. Lanes add their Graphile tasks here (one file per step/job
 * per the constitution's code-structure rules) and the crontab in `crontab.ts`
 * refers to them by name.
 *
 * A crontab entry naming a task nobody registered is a scheduled job that
 * silently never runs, so the worker refuses to **start** until every scheduled
 * task has a handler. That check is the reason this registry exists rather than
 * a bare object literal at the call site.
 *
 * It used to disable the schedule instead, which was right while this registry
 * was empty by design and wrong from the first handler onwards: one misspelt
 * name took the product's whole clock down and left it looking healthy.
 *
 * **Registering here is also what puts a job behind the kill switches.** Every
 * handler is wrapped so the switches are read at the moment the job starts;
 * a paused job returns having done nothing, without failing. Doing it here
 * rather than asking each lane to remember is the whole point — a switch that
 * half the code paths consult is not a switch. The short list of jobs that must
 * keep running while the product is paused, and why each one does, is
 * `UNGATED_TASKS` in `gate.ts`.
 */
/**
 * Whether a job works on one account's data, and therefore whether the runtime
 * holds it to the per-account lock.
 *
 * Every job must say. There is no default, so a new job cannot be added without
 * somebody deciding — which is the whole mechanism: the previous state of
 * affairs was six workers taking the lock by hand and nothing noticing a
 * seventh that forgot.
 *
 * Why four values and not a boolean. A source scan tried this first and
 * classified five of thirty-three jobs one way and twenty-eight the other,
 * because most jobs are neither: they walk every account and do the per-account
 * work inside, one store at a time. Collapsing those into either bucket makes
 * the answer a guess. Each value below says what the runtime can therefore
 * check, and two of them say plainly that it checks nothing.
 */
export type AccountWork =
  /**
   * Works on the single account named in its own payload. The runtime **fails
   * the job** if it finishes without having held that account's lock.
   */
  | 'per_account'
  /**
   * Works on one account, but learns which one from the row it loads rather
   * than from its payload — the email sender is handed a message id and reads
   * the account off the record.
   *
   * The runtime checks that a lock **was** asked for and cannot check it was
   * the right account, because it has no way to know which account was meant.
   * Weaker than `per_account` and stronger than nothing, which is why it is its
   * own value rather than being folded into either neighbour.
   */
  | 'account_from_record'
  /**
   * Walks many accounts and does the per-account work inside, so its own
   * payload names no account.
   *
   * **Not checked, and this is the honest limit of the mechanism.** The runtime
   * cannot tell "locked every account it touched" from "touched none" — both
   * look the same from outside. What holds these is that the work they fan out
   * to is itself registered or written per account. Narrowing this is a real
   * card, not a comment.
   */
  | 'fans_out'
  /** Touches no account's data at all — a global sweep, a queue drain, an outbound send. */
  | 'none'

const registry = new Map<string, Task>()

/**
 * Fails a job that was declared as working on one account and did not take that
 * account's lock.
 *
 * It runs **inside** the kill-switch gate rather than outside it, and the order
 * is load-bearing: a paused job returns having done nothing and therefore takes
 * no lock, so checking from outside would report every paused job as a
 * violation.
 *
 * The failure is thrown rather than logged. A warning after the fact is read by
 * nobody, and the thing being guarded — two workers writing one store's rows at
 * once — produces corruption that is silent, permanent and impossible to
 * attribute afterwards. Throwing is late (the unsafe work has already run) but
 * it is the only signal that reaches a person.
 */
function lockCheckedTask(name: string, task: Task, accountWork: AccountWork): Task {
  if (accountWork !== 'per_account' && accountWork !== 'account_from_record') return task

  const checked = async (payload: unknown, ...rest: never[]): Promise<unknown> => {
    const declared = (payload as { accountId?: unknown } | undefined)?.accountId
    const named = typeof declared === 'string' && declared !== '' ? declared : undefined

    if (accountWork === 'per_account' && !named) {
      throw new Error(
        `[${name}] is registered as per-account work but its payload names no account, so nothing ` +
          `can serialise it. Give the payload an accountId, or register it as "account_from_record", ` +
          `"fans_out" or "none".`,
      )
    }

    // Cast rather than narrow the parameter list: Graphile hands the handler a
    // helpers argument, and a wrapper that quietly dropped it would break every
    // job that re-queues itself.
    const run = task as unknown as (...args: unknown[]) => Promise<unknown>
    const { result, locked } = await recordingAccountLocks(async () => run(payload, ...rest))

    const satisfied = named ? locked.has(named) : locked.size > 0
    if (!satisfied) {
      throw new Error(
        `[${name}] finished without asking for the account lock${named ? ` on ${named}` : ''}, so ` +
          `another worker could have been writing the same rows at the same time. Wrap the work in ` +
          `withAccountLock, or register the job as "fans_out" or "none" if it genuinely does not ` +
          `touch one account's data.`,
      )
    }
    return result
  }

  return checked as Task
}

export function registerTask(name: string, task: Task, accountWork: AccountWork): void {
  if (registry.has(name)) {
    throw new Error(`task "${name}" is already registered`)
  }
  registry.set(name, guardedTask(name, lockCheckedTask(name, task, accountWork) as never) as Task)
}

export function taskList(): TaskList {
  return Object.fromEntries(registry)
}

export function registeredTaskNames(): string[] {
  return [...registry.keys()]
}

/** Test-only. */
export function clearTasks(): void {
  registry.clear()
}
