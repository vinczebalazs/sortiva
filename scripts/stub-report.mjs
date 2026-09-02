#!/usr/bin/env node
/**
 * `pnpm stubs:report` — lists every seam still served by a test double. A CI
 * check fails if any is still wired at the M3 exit gate.
 *
 * Through M0 every seam is a stub and this is expected to list all of them; the
 * milestone exit gates pass `--fail-if-any` once their producer card has landed.
 *
 * Why it matters more than it sounds: `existingTargetCheck` returning `no_match`
 * forever means every CREATE bypasses the check that stops us publishing a
 * second page competing with one we already have — and nothing about the
 * product would look broken.
 */
const failIfAny = process.argv.includes('--fail-if-any')
const milestoneArg = process.argv.find((a) => a.startsWith('--milestone='))
const milestone = milestoneArg?.split('=')[1]

const { wiredStubs } = await import('../packages/core/src/contracts/stubs.ts')
const doubles = await import('../packages/core/src/contracts/doubles.ts')

// Constructing each double is what registers it; the registry is otherwise
// empty in a fresh process.
new doubles.StubExistingTargetCheck()
new doubles.StubOpportunitySource()
new doubles.StubTopicScheduler()
new doubles.StubJudgeLite()
new doubles.StubCatalogEvents()
new doubles.StubNotificationEmitter()

// Not every stub is a class. The attention list's three article-backed readers
// register when their module loads, because there is nothing to construct —
// importing it is what wires them.
await import('../packages/core/src/notifications/ports.ts')

// The two halves of the email pipeline that cannot see articles yet: the
// monthly summary cannot report what went live or what the quality bar held
// back, and the seven-day "where did you publish this" reminder can find nothing
// to remind anyone about. Both register on import, and both are the reason this
// report exists — a summary reporting an empty month looks exactly like a store
// that had a quiet one.
await import('../packages/jobs/src/notify/assembler.ts')
await import('../packages/jobs/src/notify/export-url-reminder.ts')

const stubs = wiredStubs()

console.log(`${stubs.length} stub(s) wired:\n`)
for (const stub of stubs) {
  console.log(`  ${stub.contract}`)
  console.log(`    filled by:  ${stub.filledBy}`)
  console.log(`    behaviour:  ${stub.behaviour}`)
  console.log(`    gone by:    ${stub.mustBeGoneBy}`)
  console.log()
}

if (milestone) {
  const overdue = stubs.filter((s) => s.mustBeGoneBy <= milestone)
  if (overdue.length > 0) {
    console.error(`FAIL  ${overdue.length} stub(s) should have been replaced by ${milestone}:`)
    for (const stub of overdue) console.error(`      - ${stub.contract} (${stub.filledBy})`)
    process.exit(1)
  }
  console.log(`PASS  no stub is overdue at ${milestone}`)
}

if (failIfAny && stubs.length > 0) {
  console.error(`FAIL  ${stubs.length} stub(s) still wired.`)
  process.exit(1)
}
