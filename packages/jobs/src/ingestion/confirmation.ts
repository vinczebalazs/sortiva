import { accountAttribution } from '@sortiva/core'
import { inputVersion } from '../runtime/idempotency'
import type { StepDefinition } from './steps'

/**
 * Step eight: onboarding stops asking and starts waiting.
 *
 * Everything up to `keywords_competitors` was arithmetic and model calls the
 * merchant never had to be present for. This step is the hinge: it moves the
 * store onto the review screen (main §6.8) and rings the bell that tells the
 * merchant it is ready. Nothing here reads or writes the profile itself — the
 * confirmation route does that — this only opens the door to it.
 *
 * **It does not wait for Search Console.** `gsc_connect` depends on the same
 * step this does (`keywords_competitors`) but this step does not depend on
 * *it* — a merchant who skips Search Console must still be able to reach the
 * review screen; they simply carry on in Limited Intelligence mode (main
 * §7.11). See `STEP_DEPENDENCIES` in `../runtime/steps.ts`.
 */

export interface ConfirmationGateOutput {
  readonly movedTo: 'needs_confirmation'
}

export const confirmationGateStep: StepDefinition = {
  /**
   * A pure gate with no data of its own to key on — the input is "onboarding's
   * automatic steps are done", which is exactly the dependency graph's job to
   * decide. A fixed version means this runs exactly once per account; nothing
   * about the review screen ever asks it to run again on the same run.
   */
  async inputVersion() {
    return inputVersion({ step: 'confirmation_gate' })
  },

  async execute(deps, ctx): Promise<ConfirmationGateOutput> {
    const domain = await deps.domains.readNormalized(ctx.accountId)

    // Not gated on the result: two workers racing here can only ever agree —
    // the loser's guard misses because the winner already moved the row, and
    // both have done everything this step needs to do either way. The
    // idempotency ledger is what stops the notification firing twice, not
    // this guard.
    await deps.domains.transition(ctx.accountId, ['ingesting'], 'needs_confirmation')

    await deps.notifications?.emit(
      'ingestion_review_ready',
      { ingestion_job_id: ctx.jobId },
      `ingestion_review:${ctx.jobId}`,
      accountAttribution(ctx.accountId, domain),
    )

    ctx.log.info('confirmation_gate.completed', {})

    return { movedTo: 'needs_confirmation' }
  },
}
