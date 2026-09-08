import type { Logger, PublishAttemptOutcome } from '@sortiva/core'
import { accountScope, recordPublishAttempt, type Db } from '@sortiva/db'

/**
 * Writing down that we asked a merchant's shop to publish something.
 *
 * Making the request is what creates the obligation to record it, not the
 * request succeeding — the same rule the vendor spend ledger follows, and for
 * the same reason: the ending nobody writes down is the one that costs us. Here
 * the ending that used to vanish is a refusal, because refusing is what deletes
 * the claim row, so the row written here is the only lasting evidence that a
 * shop turned a post away at all.
 *
 * So it is written as close to the shop's answer as the code can put it, before
 * any of the bookkeeping that follows from that answer. A worker that dies in
 * between still loses the row — nothing short of writing it before we ask could
 * prevent that, and we do not know the ending until it answers — but everything
 * after the answer is on the far side of the record rather than in front of it.
 *
 * **A failure to record can never fail a publish.** If this insert throws, the
 * post has either landed or been refused already, and turning that into a
 * thrown error would either strand a claim nobody releases or retry a
 * publication the merchant has already received. It is logged at error level
 * instead, which is the signal that the brake's numbers have a hole in them.
 */
export async function recordAttempt(input: {
  readonly db: Db
  readonly log: Logger
  readonly accountId: string
  readonly articleId: string | null
  readonly articleExternalId: string
  readonly outcome: PublishAttemptOutcome
  readonly failureClass: string | null
  readonly at: Date
}): Promise<void> {
  try {
    await recordPublishAttempt(input.db, accountScope(input.accountId), {
      articleId: input.articleId,
      articleExternalId: input.articleExternalId,
      outcome: input.outcome,
      failureClass: input.failureClass,
      endedAt: input.at,
    })
  } catch (error) {
    input.log.error('publish_attempt_unrecorded', {
      account_id: input.accountId,
      article_external_id: input.articleExternalId,
      outcome: input.outcome,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
