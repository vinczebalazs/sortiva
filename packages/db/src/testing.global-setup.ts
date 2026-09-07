import { databaseAvailable, prepareTestTemplate } from './testing'

/**
 * Runs once, before any test file, and builds the migrated database every
 * database-backed suite is stamped out of.
 *
 * It has to happen here rather than lazily inside the first suite that needs
 * it. Building it takes as long as the whole migration set does, and it is
 * guarded so that only one process builds it; a suite that merely waits for
 * someone else to finish would still be spending that time inside its own
 * ten-second setup budget, and would fail the file for something that is not
 * its fault. Before any suite starts, nobody is waiting.
 *
 * Does nothing when there is no Postgres listening, so the unit tests still run
 * without Docker.
 */
export async function setup(): Promise<void> {
  if (!(await databaseAvailable())) return
  await prepareTestTemplate()
}
