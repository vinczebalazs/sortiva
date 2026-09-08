import { afterEach, describe, expect, it } from 'vitest'
import { UnrecordedCapture } from '@sortiva/providers'
import { resetWorkerLiveness, workerLiveness } from '@sortiva/core/observability/health'
import { bootstrapWorker } from './bootstrap'
import { installKillSwitchReader } from './gate'
import { clearTasks, registerTask } from './tasks'

/**
 * The worker does everything the product does on its own: writes the day's
 * article, reconciles billing overnight, pulls Search Console, finishes
 * publishes that were interrupted. All of it hangs off one schedule.
 *
 * A schedule entry naming a handler nobody registered used to turn that whole
 * schedule off — not the one entry, all of it — and say so in a single line of
 * log. The web server carried on serving pages, the health check said the
 * worker was running, and it was: doing nothing, forever, until a person
 * happened to read that line.
 *
 * So these two cases are the ones that matter, and they are driven through the
 * function the deployed server actually calls. The guard written for this does
 * exist elsewhere and throws with the missing names — but it only ran once the
 * schedule was enabled, which is the flag a missing name had just switched off,
 * and the tests that covered it called it directly or forced the flag on. It
 * could not fire in production by construction.
 */

const quiet = { log: () => {}, error: () => {} }

// The worker refuses to start without a way to read the kill switches, and that
// check comes first. These cases are about the schedule, so they install a
// reader that is never consulted.
installKillSwitchReader(() => undefined as never)

const UNREGISTERED = [
  { task: 'a_job_nobody_registered', schedule: '0 3 * * *', why: 'stands in for a misspelt name' },
]

describe('a scheduled job with no handler stops the worker', () => {
  afterEach(() => {
    clearTasks()
    resetWorkerLiveness()
  })

  it('refuses to start, and says which name it could not find', async () => {
    resetWorkerLiveness()

    await expect(
      bootstrapWorker({
        analytics: new UnrecordedCapture(),
        logger: quiet,
        cronEntries: UNREGISTERED,
      }),
    ).rejects.toThrow(/a_job_nobody_registered/)
  })

  it('leaves the health check able to say the worker is not there', async () => {
    resetWorkerLiveness()

    await bootstrapWorker({
      analytics: new UnrecordedCapture(),
      logger: quiet,
      cronEntries: UNREGISTERED,
    }).catch(() => undefined)

    const liveness = workerLiveness()
    // "Refused" rather than "stopped for some reason": a container that will
    // never work should not look like one having a bad minute.
    expect(liveness.status).toBe('stopped')
    expect(liveness.status === 'stopped' && liveness.reason).toContain('refused to start')
    expect(liveness.status === 'stopped' && liveness.reason).toContain('a_job_nobody_registered')
  })

  it('gets past that guard once the handler is registered, which is what stops this being a blanket refusal', async () => {
    resetWorkerLiveness()
    registerTask('a_job_nobody_registered', async () => {})

    // A connection string pointing at nothing, so the worker fails at the next
    // step instead. What is being asserted is *which* failure: not the
    // schedule's, which would mean the registration had not been seen.
    await expect(
      bootstrapWorker({
        analytics: new UnrecordedCapture(),
        connectionString: 'postgres://sortiva:sortiva@127.0.0.1:1/sortiva',
        logger: quiet,
        cronEntries: UNREGISTERED,
      }),
    ).rejects.toThrow()

    const liveness = workerLiveness()
    expect(liveness.status === 'stopped' && liveness.reason).toContain('failed to start')
    expect(liveness.status === 'stopped' && liveness.reason).not.toContain('refused to start')
  })
})
