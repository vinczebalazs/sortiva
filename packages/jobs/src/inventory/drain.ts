import { catalogEventsToTargets, type CatalogEvents } from '@sortiva/core'
import type { Db } from '@sortiva/db'
import {
  INVENTORY_CATALOG_EVENTS_TASK,
  enqueueCatalogEventDrain,
  enqueueInventorySync,
  type CatalogEventDrainPayload,
} from './queue'
import { registerTask } from '../runtime/tasks'
import { runtimeLogger } from '../runtime/logging'
import type { Logger } from '@sortiva/core'

/**
 * Turning "the merchant changed something" into "re-read exactly that page".
 *
 * Without this the inventory is only ever as fresh as last night's walk, so a
 * merchant who rewrites a collection in the morning would see us go on
 * recommending against the old wording all day.
 *
 * This is the reading half. The half that produces the changes is Lane B's, and
 * is not built yet; until it is, nothing calls this and the nightly walk is the
 * only thing keeping the inventory current.
 */

export interface CatalogEventDrainDeps {
  readonly getDb: () => Db
  readonly catalogEvents: CatalogEvents
  readonly logger?: Logger
}

export interface CatalogEventDrainResult {
  /** Changes read from the stream this pass. */
  readonly events: number
  /** Pages queued for re-reading. */
  readonly requested: number
  /** Things the store says are gone. Counted, not acted on — see DECISIONS 2026-09-02 T3.2. */
  readonly removed: number
  /** Where to resume. Handed back to the queue so no second place has to store it. */
  readonly cursor: string
}

/**
 * Reads one store's changes since we last looked, and asks for the pages they
 * touched to be re-read.
 *
 * The cursor travels in the job payload rather than in a table: the stream's own
 * interface hands it to us and expects it back, the queue already durably holds
 * a payload per job, and giving it a column would mean a migration outside a
 * schema wave. The cost is that losing the job loses our place, which costs one
 * extra pass over the stream — see DECISIONS 2026-09-02 T3.2.
 */
export async function drainCatalogEvents(
  deps: CatalogEventDrainDeps,
  payload: CatalogEventDrainPayload,
): Promise<CatalogEventDrainResult> {
  const log = deps.logger ?? runtimeLogger()
  const { events, cursor } = await deps.catalogEvents.since(payload.accountId, payload.cursor)
  const fanout = catalogEventsToTargets(events)

  if (fanout.resync.length > 0) {
    await enqueueInventorySync(deps.getDb(), {
      accountId: payload.accountId,
      targets: fanout.resync,
    })
  }

  log.info('inventory_catalog_events_drained', {
    account_id: payload.accountId,
    events: events.length,
    requested: fanout.resync.length,
    removed: fanout.removed.length,
  })

  return {
    events: events.length,
    requested: fanout.resync.length,
    removed: fanout.removed.length,
    cursor,
  }
}

export function registerCatalogEventTasks(deps: CatalogEventDrainDeps): void {
  if (registered) return
  registered = true

  registerTask(INVENTORY_CATALOG_EVENTS_TASK, async (rawPayload) => {
    const payload = rawPayload as CatalogEventDrainPayload
    const result = await drainCatalogEvents(deps, payload)

    // A pass that found something is a reason to look again straight away: a
    // merchant editing their catalogue does it in bursts, and the stream may
    // have more waiting. A pass that found nothing stops, and the next burst is
    // announced by whoever queues this.
    if (result.events > 0) {
      await enqueueCatalogEventDrain(deps.getDb(), {
        accountId: payload.accountId,
        cursor: result.cursor,
      })
    }
  })
}

let registered = false

/** Test-only: the task registry is a module singleton, and so is this latch. */
export function resetCatalogEventTaskRegistration(): void {
  registered = false
}
