/** A daily spending cap would be exceeded; the store pauses until tomorrow, nothing degrades. */
export class BudgetExceededError extends Error {
  constructor(readonly scope: 'store' | 'global', readonly storeId: number | null) {
    super(scope === 'store' ? `store ${storeId} reached its daily spending cap` : 'the global daily spending cap is reached')
  }
}

/** The model's answer did not have the required shape, twice. */
export class MalformedOutputError extends Error {}

/** The model declined to answer. The work is held; no other model is tried. */
export class ModelRefusedError extends Error {}
