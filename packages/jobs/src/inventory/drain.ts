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
import { runEventDrivenScan } from '../scan/event'
import type { RunSignalScanDeps } from '../scan/run'
import type { Logger } from '@sortiva/core'

/**
 * Turning "the merchant changed something" into "re-read exactly that page".
 *
 * Without this the inventory is only ever as fresh as last night's walk, so a
 * merchant who rewrites a collection in the morning would see us go on
 * recommending against the old wording all day.
 *
 * This is the reading half. The half that produces the changes — the Shopify
 * webhook handler and the nightly catalogue sweep, both Lane B's — writes them
 * to the shared change record, and the webhook handler asks for a pass the
 * moment it records one.
 */

export interface CatalogEventDrainDeps {
  readonly getDb: () => Db
  readonly catalogEvents: CatalogEvents
  readonly logger?: Logger
  /**
   * What a full opportunity scan needs, built on demand rather than handed over
   * up front. A merchant's edit is worth re-scanning the store's opportunities
   * for, not only re-reading the page — otherwise a missing title fixed on
   * Tuesday is not noticed until the weekly scan on Monday.
   *
   * A function and not an object because building it means opening a database
   * connection and taking the shared pool, and registering a task must not do
   * either: registration happens while the server is starting up, long before
   * any job runs. Optional so a test can leave the scan out.
   */
  readonly signalScan?: () => RunSignalScanDeps
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

    // Fires alongside the queued resync, not strictly after it lands — the
    // resync is a separate queued job (`INVENTORY_SYNC_TASK`) this function
    // has no handle on waiting for, and threading that through would mean
    // reaching into `packages/jobs/src/inventory/tasks.ts`'s own task
    // registration. So the scan reads the pages as they were before this
    // pass's re-reads land; the next change, or the weekly scan, catches up.
    if (deps.signalScan) {
      await runEventDrivenScan(deps.signalScan(), payload.accountId, { cursor })
    }
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
  }, 'per_account')
}

let registered = false

/** Test-only: the task registry is a module singleton, and so is this latch. */
export function resetCatalogEventTaskRegistration(): void {
  registered = false
}
