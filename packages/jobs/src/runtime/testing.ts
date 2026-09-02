import { makeWorkerUtils, type WorkerUtils } from 'graphile-worker'

/**
 * Installs the queue's own tables into a test database, and hands back the
 * handle that has to be released afterwards.
 *
 * The queue's schema is created by the worker at start-up, not by our
 * migrations, so a test database built from migrations alone has no queue in
 * it. In production the worker starts in the web server's own process before a
 * request can arrive; a test that exercises code which queues work has to do
 * the equivalent itself.
 *
 * Lives here because this is the package that depends on the queue library. A
 * test elsewhere calling it does not have to take that dependency of its own.
 */
export async function installQueueSchema(connectionString: string): Promise<WorkerUtils> {
  const utils = await makeWorkerUtils({ connectionString })
  await utils.migrate()
  return utils
}

/** Every job waiting on the queue, whatever it is — for a test that starts clean. */
export const TRUNCATE_QUEUE_SQL = 'TRUNCATE graphile_worker._private_jobs CASCADE'

export type { WorkerUtils }
