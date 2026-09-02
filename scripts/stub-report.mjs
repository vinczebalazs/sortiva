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
//
// `StubExistingTargetCheck` is deliberately not constructed, from 2026-09-03:
// `T3.5` filled that seam. The rule lives in `@sortiva/core`
// (`findExistingTarget`) and the store's real data is gathered behind it by
// `DbExistingTargetCheck` in `@sortiva/jobs`. **Stated plainly, because the
// note above about the notifications seam sets a higher bar than this one
// meets:** no production code calls the check yet, because both its consumers
// are cards nobody has written — `T3.6` (opportunity creation) and `T4.1`
// (Lane D's topic gate). What has changed is that a caller can no longer get a
// silent "no match": the stand-in is gone, and a new page cannot be proposed
// without the clearance only the real check mints.
new doubles.StubOpportunitySource()
new doubles.StubTopicScheduler()
new doubles.StubJudgeLite()
// `StubCatalogEvents` is deliberately not constructed. `T2.2` filled that seam:
// the change stream is served in production by `DatabaseCatalogEvents`, reading
// what merchants actually changed. The double still exists and is still used by
// tests, which is fine — this report is about seams the *product* is running on
// a stand-in, and listing a filled one would make the M2 gate fail for a gap
// that no longer exists.
// `StubNotificationEmitter` is deliberately not constructed either, for the same
// reason and from 2026-09-02: the Shopify composition root now hands out
// `DbNotificationEmitter`, so a notification written in production reaches a real
// row and — for the kinds that are emailed — a real queued send. The double still
// exists and tests still use it. **Unlike the catalogue-events seam, this one was
// checked end to end before the line was removed**: the emitter is constructed in
// `apps/web/app/api/shopify/_lib/config.ts`, not merely exported.

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

// The two brakes that cannot see. The judge fail-rate and publish error-rate
// trips are built and tested, but nothing records a draft's gate decision or a
// publish attempt yet — no `articles` table, no `publish_intents` — so each is
// wired to a counter that reports "not measurable" rather than a healthy zero.
// The arithmetic is real; only the counting is missing.
const ops = await import('../packages/core/src/ops/counters.ts')
new ops.UnrecordedJudgeOutcomes()
new ops.UnrecordedPublishOutcomes()

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
