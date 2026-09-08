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
//
// `StubOpportunitySource` is deliberately not constructed, from 2026-09-03:
// `T3.6` filled the seam (`DbOpportunitySource`, `packages/jobs/src/scan/
// opportunity-source.ts`) and `T3.7` gave it a real production caller —
// `runOnboardingScan`'s calendar-seeding step (`packages/jobs/src/scan/
// onboarding.ts`) constructs it and calls `.acceptedContentOpportunities()`,
// not a hand-rolled read of the same table. Checked end to end, the same bar
// the notifications-seam note above sets: `sweepOnboardingRuns` is
// registered as the `signal_scan_onboarding_sweep` crontab task in
// `apps/web/instrumentation.ts`, so a confirmed account really does reach
// this seam in production, not merely in a test.
//
// `StubTopicScheduler` is deliberately not constructed, from 2026-09-03:
// `T4.2` filled the seam (`DbTopicScheduler`, `packages/jobs/src/generation/
// topic-scheduler.ts`) and this line was simply never removed, so the M4 gate
// has been failing on bookkeeping. Checked to the same bar the notifications
// note above sets rather than taken from a card's report: the real class is
// constructed in three production callers — `runOnboardingScan`'s
// calendar-seeding step (registered as the `signal_scan_onboarding_sweep`
// crontab task), the schedule action behind `POST /api/opportunities/{id}`,
// and `T4.6`'s monthly replenishment job (registered as
// `replenishment_monthly`). The double still exists and its own tests still
// use it; nothing in production does.
// `StubJudgeLite` is deliberately not constructed, from 2026-09-08. The line
// was stale rather than wrong-headed: `R-OPTIMIZE-WIRE` gave the seam a real
// implementation and nobody came back here, so this report has been announcing
// that "the quality bar is not actually applied" while it was. Checked end to
// end to the standard the notes above set: `LlmJudgeLite` is built
// unconditionally in the improve-this-page worker's dependencies
// (`apps/web/app/api/recommendations/_lib/config.ts`), and those dependencies
// are handed to `registerOptimizeTasks` in the composition root
// (`apps/web/instrumentation-node.ts`), so a merchant's click really is graded
// by the real judge. The double still exists and its own tests still use it.
//
// This mattered beyond bookkeeping: a report whose first entry a reader has
// learned to discount is a report they discount entirely, and the two entries
// below it are true.
// `StubCatalogEvents` is deliberately not constructed, from 2026-09-04, and this
// is the third note in this place — the first two were wrong, so the standard
// here is higher than a card's report. What is true now, checked end to end:
// the Shopify webhook handler writes every change a merchant makes to the shared
// record and then asks for a pass over it; `DatabaseCatalogEvents` is built in
// the composition root (`apps/web/instrumentation-node.ts`) and handed to the
// drain task registered there, so the ask reaches a real reader; and the reader
// re-reads the changed pages and re-scans the store's opportunities. Both halves
// run, not just the writing one. `seams-wired.test.ts` holds this claim to the
// rule the earlier removal broke: a seam leaves this report only when its real
// implementation is constructed somewhere that is not a test.
// `StubNotificationEmitter` is deliberately not constructed either, for the same
// reason and from 2026-09-02: the Shopify composition root now hands out
// `DbNotificationEmitter`, so a notification written in production reaches a real
// row and — for the kinds that are emailed — a real queued send. The double still
// exists and tests still use it. **Unlike the catalogue-events seam, this one was
// checked end to end before the line was removed**: the emitter is constructed in
// `apps/web/app/api/shopify/_lib/config.ts`, not merely exported.

// The attention list is no longer on this list at all, from 2026-09-04
// (`T5.3`), and the import that used to wire it is gone with it. Held to the
// same end-to-end standard the notes above set rather than taken from a card's
// report: the last stand-in was pending repairs, which returned nothing because
// nothing recorded a repair. It now reads the store's own open repairs —
// `openRepairs` in `packages/db/src/repositories/repair.ts`, bound in
// `makeNotificationStore`, which is what the dashboard's attention route is
// handed. No repairs table was added; a repair is an opportunity row, so the
// read is over rows the daily drift pass really writes.

// The two halves of the email pipeline that could not see articles are gone
// from this list, from 2026-09-03 (`R-ARTICLES`), and their imports with them:
// the monthly summary counts what actually went live and what the gates held
// back, and the seven-day "where did you publish this" reminder reads its own
// articles. Checked the way the note above demands rather than taken on trust:
// `registerExportUrlReminderTask` now defaults to the real database source, and
// that task is registered in `apps/web/instrumentation-node.ts`, so the sweep a
// deployed worker runs reads real rows.

// The judge fail-rate counter is no longer on this list, from 2026-09-08
// (`R-BRAKES-BLIND`), and the note it replaces was a reason that had expired:
// it said no table records a draft's gate decision, and `gate_decisions` had
// been in the schema for weeks. Checked end to end to the standard the notes
// above set, and the check is cheap here because there is nothing to wire — the
// sweep builds the counter out of the database handle it already holds
// (`gateDecisionJudgeCounter`, `packages/jobs/src/sweeps/auto-trips.ts`), and
// that sweep is the registered `spend_cap_sweep` task. `auto-trips.test.ts`
// plants real gate-3 rows, runs the sweep with no counter supplied, and watches
// the switch go up — so what is asserted is the brake firing, not the wiring.
//
// The publish error-rate counter stays, and the reason has changed rather than
// gone. `publish_intents` exists now, but it cannot answer this question: a
// publish that the shop refuses — the ordinary failure, and the shape of the
// platform outage this brake is for — deletes its own claim row so the next
// attempt can take the name back. Counting what is left would report a healthy
// zero straight through an outage. Closing it needs a durable record of an
// attempt and its outcome, which is a schema change; see `DECISIONS.md`,
// 2026-09-08.
const ops = await import('../packages/core/src/ops/counters.ts')
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

/**
 * Milestones are compared as the numbers they are, not as the strings they
 * look like. `'M10' <= 'M4'` is true in JavaScript — 1 sorts before 4 — so
 * every gate from M2 onwards was reporting the two M10 counters as overdue,
 * and every reader of the M4 gate had to know to discount them. A label this
 * cannot parse sorts last rather than first, so an unrecognised one can never
 * fail a gate by accident.
 */
function milestoneOrder(label) {
  const digits = /^M(\d+)$/.exec(String(label))
  return digits ? Number(digits[1]) : Number.POSITIVE_INFINITY
}

if (milestone) {
  const due = milestoneOrder(milestone)
  const overdue = stubs.filter((s) => milestoneOrder(s.mustBeGoneBy) <= due)
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
