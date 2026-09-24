#!/usr/bin/env node
/**
 * `pnpm dlq list` / `pnpm dlq replay <id>` — the one action that puts
 * permanently-failed work back on the queue.
 *
 * Replaying is safe rather than merely allowed: every step's idempotency key is
 * derived from its inputs, so sub-work that already completed is recognised and
 * skipped, and only the remainder actually runs. That is why this is one
 * command and not a procedure.
 *
 * `list` exists because `replay` needs an id and there was previously no way to
 * get one except by hand-writing SQL — which is the thing this pair removes.
 *
 * Runs under `tsx`; the repo consumes workspace packages as TypeScript source.
 */
import { closeDb, db as database } from '../packages/db/src/client.ts'
import { dlqDepth, listOpenDlq, replayDlqEntry } from '../packages/jobs/src/runtime/dlq.ts'

const [command, ...rest] = process.argv.slice(2).filter((arg) => arg !== '--')

if (!command || command === '--help' || command === '-h') {
  usage(2)
}

if (!process.env.DATABASE_URL) {
  console.error('FAIL  DATABASE_URL is not set')
  process.exit(1)
}

const db = database()
const when = (value) => (value ? new Date(value).toISOString() : '—')

try {
  if (command === 'list') {
    const entries = await listOpenDlq(db)
    const depth = await dlqDepth(db)
    if (entries.length === 0) {
      console.log('Nothing has failed for good. The dead-letter queue is empty.')
    } else {
      console.log(`${depth} entr(y/ies) waiting to be replayed:`)
      for (const entry of entries) {
        console.log('')
        console.log(`  ${entry.id}`)
        console.log(`    step        ${entry.step} (${entry.errorClass}) after ${entry.attempts} attempt(s)`)
        console.log(`    account     ${entry.accountId ?? 'none — this work belongs to no single store'}`)
        console.log(`    first fail  ${when(entry.firstFailedAt)}`)
        console.log(`    last error  ${entry.lastError}`)
      }
      console.log('')
      console.log('Replay one with: pnpm dlq replay <id>')
    }
  } else if (command === 'replay') {
    const id = rest[0]
    if (!id) {
      console.error('FAIL  which entry? Usage: pnpm dlq replay <id>  (ids come from `pnpm dlq list`)')
      process.exit(2)
    }
    const by = process.env.SORTIVA_OPERATOR ?? process.env.USER ?? 'operator'
    const outcome = await replayDlqEntry(db, id, by)

    if (outcome.status === 'replayed') {
      console.log(`Replayed ${outcome.entry.step} for account ${outcome.entry.accountId ?? 'none'}.`)
      if (outcome.dispatched) {
        console.log('Its step is back to pending and a worker has been asked to take it.')
      } else {
        console.log(
          'Its step is back to pending. The entry names no account, so nothing could be asked to run it — this needs a person.',
        )
      }
      console.log('Work that already completed will be recognised and skipped — only the failed remainder runs.')
    } else if (outcome.status === 'already_replayed') {
      console.log('Nothing to do: that entry was already replayed (or there is no entry with that id).')
      process.exit(1)
    } else {
      console.log(`Entry ${outcome.entry.id} carries no step to reschedule.`)
      console.log(
        'Either its step row is gone, or this was never an ingestion step — publishes, sweeps and email sends dead-letter here too. It is marked replayed, but nothing was requeued.',
      )
      process.exit(1)
    }
  } else {
    console.error(`FAIL  unknown command "${command}"`)
    usage(2)
  }
} catch (error) {
  console.error(`FAIL  ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  await closeDb()
}

function usage(code) {
  console.error('Usage:')
  console.error('  pnpm dlq list                 what has failed for good and is waiting')
  console.error('  pnpm dlq replay <id>          put one entry back on the queue')
  process.exit(code)
}
