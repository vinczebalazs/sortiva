#!/usr/bin/env node
/**
 * `pnpm stubs:report` — build plan §4: "a CI check fails if any stub is still
 * wired at M3 exit", and T0.7's done-when: "wired-stub report lists all stubs
 * (expected: all)".
 *
 * Through M0 every seam is a stub and this is expected to list all of them; the
 * milestone exit gates pass `--fail-if-any` once their producer card has landed.
 *
 * Why it matters more than it sounds: `existingTargetCheck` returning `no_match`
 * forever means every CREATE bypasses the check main §7.7 makes mandatory
 * before any CREATE — invariant 6 — and nothing about the product would look
 * broken.
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
