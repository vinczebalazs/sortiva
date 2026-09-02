#!/usr/bin/env node
/**
 * `pnpm diagnose <email or domain>` — prints one store's state and every step
 * of its pipeline, so answering "why is this store stuck" is not hand-written
 * SQL at the moment somebody is waiting for the answer.
 *
 * Reads only. It never enqueues, retries or repairs anything; `pnpm dlq` is
 * what does that.
 *
 * The repo consumes workspace packages as TypeScript source, so this runs under
 * `tsx`, which is what the `diagnose` package.json entry invokes.
 */
import { diagnoseStoreAt } from '../packages/db/src/diagnose.ts'

const args = process.argv.slice(2).filter((arg) => arg !== '--')

if (args.length !== 1 || args[0] === '--help' || args[0] === '-h') {
  console.error('Usage: pnpm diagnose <email or domain>')
  console.error('   e.g. pnpm diagnose merchant@example.com')
  console.error('        pnpm diagnose example-outdoor.com')
  process.exit(2)
}

const target = args[0]
// An email is the one thing a domain can never look like, so the operator does
// not have to remember a flag under pressure.
const selector = target.includes('@') ? { email: target } : { domain: target }

let diagnosis
try {
  diagnosis = await diagnoseStoreAt(selector)
} catch (error) {
  console.error(`FAIL  ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

if (!diagnosis) {
  console.log(
    `No store found for ${'email' in selector ? `the address ${selector.email}` : `the domain ${selector.domain}`}.`,
  )
  console.log('Nothing is wrong with the pipeline — there is simply no such account here.')
  process.exit(1)
}

const when = (value) => (value ? new Date(value).toISOString() : '—')
const line = (label, value) => console.log(`${label.padEnd(18)}${value}`)

console.log('')
console.log(`Store ${diagnosis.email}`)
console.log('='.repeat(60))
line('Account', diagnosis.accountId)
line('Signed up', when(diagnosis.createdAt))
if (diagnosis.deletedAt) line('DELETED', when(diagnosis.deletedAt))
line('Subscription', diagnosis.subscriptionStatus ?? 'none recorded')

console.log('')
if (diagnosis.domain) {
  line('Domain', diagnosis.domain.normalized)
  line('  state', diagnosis.domain.state)
  line('  platform', diagnosis.domain.platform ?? 'not detected yet')
  line('  claimed', when(diagnosis.domain.claimedAt))
  if (diagnosis.domain.releaseAfter) line('  releases', when(diagnosis.domain.releaseAfter))
} else {
  console.log('Domain            none claimed — onboarding has not started')
}

console.log('')
if (diagnosis.shopify) {
  line('Shopify', diagnosis.shopify.shopHandle)
  line('  scopes', diagnosis.shopify.grantedScopes.join(', ') || 'none recorded')
  line('  connected', when(diagnosis.shopify.connectedAt))
  if (diagnosis.shopify.invalidatedAt) {
    line('  INVALIDATED', `${when(diagnosis.shopify.invalidatedAt)} — the merchant must reconnect`)
  }
} else {
  console.log('Shopify           not connected')
}

if (diagnosis.searchConsole) {
  line('Search Console', diagnosis.searchConsole.property)
  line('  connected', when(diagnosis.searchConsole.connectedAt))
  if (diagnosis.searchConsole.invalidatedAt) {
    line('  INVALIDATED', `${when(diagnosis.searchConsole.invalidatedAt)} — reporting has stopped`)
  }
} else {
  console.log('Search Console    not connected (running in Limited Intelligence)')
}

console.log('')
if (diagnosis.runs.length === 0) {
  console.log('Pipeline          no onboarding run exists for this store')
} else {
  for (const run of diagnosis.runs) {
    console.log(`Run ${run.runId} — ${run.status}, started ${when(run.startedAt)}${run.finishedAt ? `, finished ${when(run.finishedAt)}` : ''}`)
    for (const step of run.steps) {
      const notes = []
      if (step.attempts > 0) notes.push(`${step.attempts} attempt(s)`)
      if (step.hasCheckpoint) notes.push('has a checkpoint to resume from')
      if (step.nextAttemptAt) notes.push(`retries at ${when(step.nextAttemptAt)}`)
      console.log(`  ${step.step.padEnd(22)}${step.state.padEnd(18)}${notes.join('; ')}`)
      if (step.lastError) console.log(`  ${''.padEnd(22)}last error: ${step.lastError}`)
    }
  }
}

console.log('')
if (diagnosis.openDeadLetters.length === 0) {
  console.log('Failed for good   nothing waiting to be replayed')
} else {
  console.log(`Failed for good   ${diagnosis.openDeadLetters.length} entr(y/ies) waiting — replay with \`pnpm dlq replay <id>\``)
  for (const entry of diagnosis.openDeadLetters) {
    console.log(`  ${entry.id}  ${entry.step} (${entry.errorClass}) after ${entry.attempts} attempt(s), first failed ${when(entry.firstFailedAt)}`)
    console.log(`  ${''.padEnd(38)}${entry.lastError}`)
  }
}
console.log('')
