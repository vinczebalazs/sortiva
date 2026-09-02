/**
 * The permission slip a new page needs before anything may propose writing it.
 *
 * The rule this enforces is the one the whole engine leans on: we never publish
 * a page that competes with a page the store already has. Enforcing it by
 * asking every future caller to remember to run a check first would work right
 * up until one of them forgot — and nothing about the product would look
 * broken, because a second competing page looks exactly like a first one.
 *
 * So the permission is a value rather than a habit. Only the existing-target
 * check can produce one, and any function that proposes a new page takes one as
 * an argument. A caller that skipped the check has nothing to pass; a
 * hand-written substitute does not type-check, because the brand below cannot
 * be named outside this file, and is rejected at the point of use if somebody
 * casts their way past that.
 */

/** The compile-time half: unnameable outside this module, so no literal can satisfy the type. */
declare const clearanceBrand: unique symbol

/** The runtime half: the value the guard actually looks for. Never exported. */
const MINTED_BY_CHECK = Symbol('existing-target-check')

/** Where a new page's link to an existing page of ours has to point. */
export interface InternalLinkTask {
  /** The page we already have, which the new one must link to and be linked from. */
  readonly existingUrl: string
  /** Why the pair needs linking, as a key the why-line renderer resolves. */
  readonly reasonTemplateKey: 'existing_target_weak_match_link'
}

export interface CreateClearance {
  readonly [clearanceBrand]: true
  /** The intent the check was run for, so a clearance cannot be reused for a different topic. */
  readonly clusterHead: string
  readonly checkedAt: string
  /**
   * A page of ours that covers some of this intent but was too weak to take the
   * work over. Non-null means the new page may go ahead **only** with the link
   * tasks attached, so the two are tied together instead of competing blind.
   */
  readonly weakExistingTarget: string | null
  readonly linkTasks: readonly InternalLinkTask[]
}

/**
 * Mints a clearance.
 *
 * Deliberately absent from this module's barrel: the existing-target check is
 * the only legitimate caller, and a second one would be the bug this file
 * exists to make impossible. A test asserts no other file imports it.
 */
export function mintCreateClearance(input: {
  readonly clusterHead: string
  readonly checkedAt: string
  readonly weakExistingTarget: string | null
}): CreateClearance {
  return {
    [MINTED_BY_CHECK]: true,
    clusterHead: input.clusterHead,
    checkedAt: input.checkedAt,
    weakExistingTarget: input.weakExistingTarget,
    linkTasks: input.weakExistingTarget
      ? [
          {
            existingUrl: input.weakExistingTarget,
            reasonTemplateKey: 'existing_target_weak_match_link' as const,
          },
        ]
      : [],
  } as unknown as CreateClearance
}

export class MissingExistingTargetCheckError extends Error {
  constructor(clusterHead: string) {
    super(
      `No existing-target clearance for "${clusterHead}". A new page may only be proposed once the ` +
        'existing-target check has run and found nothing better to improve.',
    )
    this.name = 'MissingExistingTargetCheckError'
  }
}

function brandOf(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return undefined
  return (value as Record<symbol, unknown>)[MINTED_BY_CHECK]
}

/**
 * The guard every producer of a new page calls first.
 *
 * Throws rather than returning false: there is no sensible way to carry on
 * without the check, and a boolean would invite somebody to log it and proceed.
 * The intent is compared too, so a clearance obtained for one topic cannot be
 * carried across to another.
 */
export function assertClearedToCreate(
  clearance: CreateClearance | null | undefined,
  clusterHead: string,
): asserts clearance is CreateClearance {
  if (brandOf(clearance) !== true) throw new MissingExistingTargetCheckError(clusterHead)
  if ((clearance as CreateClearance).clusterHead !== clusterHead) {
    throw new MissingExistingTargetCheckError(clusterHead)
  }
}

/** True when this value was minted by the check, for a caller that wants to branch rather than throw. */
export function isCreateClearance(value: unknown): value is CreateClearance {
  return brandOf(value) === true
}
