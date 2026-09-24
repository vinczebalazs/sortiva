# Kick-off prompt — fixing the engine

Written 2026-09-24. **Replaces `docs/handoff-next.md` and every earlier version of this file.**

The product is being sold through the Shopify App Store eventually, which replaces the shell around it: the sign-in page, the Stripe funnel, domain entry and platform detection all go. The engine behind that shell does not change: ingestion, Search Console, signals, opportunities, the calendar, the quality gates, writing, publishing, the learning loop, notifications, spend caps, the job runtime and the database.

**So this programme fixes the engine and ignores the shell.** Eighty confirmed defects are engine. Twelve die with the shell and are listed in `docs/fix-or-drop.md` as dropped; do not spend a minute on them.

Every decision this scope needs has been taken and is written out below. Paste everything under the line into a fresh session.

---

You are working on the Sortiva project, in `/Users/balazs/Desktop/sortiva`. You are fixing confirmed defects in the engine and removing code the product no longer needs. You are not building features. The founder is away. Work the cards in order and do not wait for answers you already have.

## Read these first, in this order

1. **`CLAUDE.md`** — the constitution. It overrides your defaults. Read the spec sections a card cites, verbatim, before you write code. Every choice the specs do not dictate goes in `DECISIONS.md` immediately.
2. **`docs/fix-or-drop.md`** — which defects are the engine and which die with the shell. Everything you touch comes from the fix side.
3. **`docs/remediation-plan.md`** §1 for the true state of the product, §5 for the full ledger with evidence per finding.
4. **`docs/agent-work-plan.md`** §3 for lane ownership, §6 for the card format.

## Where things stand

`main` is clean, pushed, and the only branch. The full gate is green: lint, lint proofs, typecheck, 349 test files and 4,661 tests, contracts at 63 routes, build, both smoke checks, chaos ten of ten, environment check, stub report, and migrations against a fresh database.

**The product has never been used by a real merchant.** Every unit is tested with its neighbours replaced by stand-ins, and every defect you are about to fix is at a join. The founder now has one real store to test against. Batch 1 is everything between the engine and one good article published on it.

## The one thing to internalise

Every defect in the ledger is a **liveness** bug and every test in the suite is a **safety** test. Safety is "when this runs it does the right thing". Liveness is "this runs at all". A retry is stamped and nothing fires it. A job is registered and nothing enqueues it. A route answers a code and no screen branches on it. A cap counts one of six spenders.

So **write every done-when from outside the unit you are changing.** Not "the function computes the right backoff" but "an onboarding run that fails once finishes without anyone touching it". If your test only proves the unit is correct, you have reproduced the bug you were sent to fix.

The corollary, confirmed seven times over by the audit that produced this list: the mechanism that tells you something is finished is often the broken thing, and it always fails reassuringly. When a check reports success, confirm it did the work.

## Decisions already taken — do not re-open

| Question | Answer |
|---|---|
| Pilot billing | Free. One real store, a custom Shopify app, no payment |
| How a free store is entitled | A **comped** state that entitles without payment |
| Stripe | Remove the purchase layer now. Keep entitlement and the subscriptions row |
| How a stalled run resumes | A scheduled sweep, not a delayed re-enqueue |
| Markdown to HTML | `markdown-it`, configured so raw HTML in the source is escaped |
| Search Console return | Carry the destination in the signed OAuth state, allowlisted to two screens |
| Railway start command | Pass the application directory. Deployment will not be run yet |
| Eval sets | Prompts may change when scores show it is better. Gold cases and thresholds stay |

**Dropped, do not fix:** sign-in landing on the plan page, app screens rendering signed out, and the remaining Stripe defects. The first two die with the embedded rebuild and are noise when one person signs in. The third goes with card 2.

## What is not yours

**Do not touch the founder's real store.** No custom app, no credentials, no connection, no publishing to it. They create the app, put its credentials in `.env`, connect the store and trigger the first publish. You prepare everything up to that point.

Work against local Postgres with `SEO_PROVIDER_MODE=mock` so no paid search-data calls are made. Card 0 is the one place that is meant to spend.

## The programme

Six batches, ordered so that the earliest work is what stands between the engine and a merchant seeing something correct. Batch 1 is written out as cards. Batches 2 to 6 list their findings; write the cards from `docs/remediation-plan.md` §5, which carries the evidence and the failure scenario for each.

| Batch | | Findings |
|---|---|---|
| 1 | One article out of one real store | 8 cards |
| 2 | The article is right, and published exactly once | 14 |
| 3 | Work never stops silently | 19 |
| 4 | Money is not burned | 7 |
| 5 | Screens tell the truth | 18 |
| 6 | Data integrity and the tail | 13 |

Do not skip ahead. If Batch 1 takes the whole session, that is the right outcome.

---

## Batch 1 — one article out of one real store

### 0 — Run the eval suite and report

No code change. Do this first so the baseline is honest.

`pnpm eval` has never run in this project's history. It grades what gets written into merchants' stores: fifty distillation cases, twenty judge cases, ten persona cases, one real model call each. The key in `.env` works.

Three rules, two of which are the spec's rather than mine:

- **Gold cases are append-only.** main §14.2 says eval sets are append-only and production failures get minimised and added as regression cases. Never edit or delete a case to make a set green. Nothing in CI enforces this, which is why it matters.
- **Thresholds are spec text.** All six pass marks are written in main §14.2. Lowering one is amending the spec and is not yours.
- **Prompts may change when the scores say so.** A prompt change is a **new version file**, never an edit in place, because the version stamped on an article a year ago must keep meaning what it said. Record before and after scores in `DECISIONS.md`. A change that does not improve the score does not land.

*Done when:* the scores are reported, whatever they are.

### 1 — A store can be entitled without paying · Lane A

Entitlement means exactly one thing today: a local subscription row with status `active` (`packages/core/src/billing/entitlement.ts`). Two gates read it, the daily generation cycle and the publish schedule. A store with no row never writes and never publishes, so the free pilot store would produce nothing at all.

Add a **comped** state that entitles. It is a real product concept, not a fixture: it survives into Shopify billing, where it is what partners and the founder's own stores will use.

Needs a column or enum value, so it needs a schema wave. Migrations land only in schema-wave cards, so file the `DECISIONS.md` entry and ask the integrator for a mini-wave rather than adding a migration yourself.

Give the founder a way to set it on one store. An admin script is the right shape; there is precedent in `scripts/`.

*Done when:* a store with no payment and a comped mark passes both gates, writes an article and publishes it, and a store with neither still does not.

### 2 — Remove the Stripe purchase layer · Lane A

The pilot is free and Shopify billing replaces Stripe for Shopify stores. Seven defects sit on code that is going, so it goes rather than gets repaired.

**Remove:** the Stripe provider, the Stripe webhook route with its receiver and event processing, the billing routes for checkout, portal and plan, the public plan page, and the billing card on Settings → Account. Sign-in then has nowhere to send people but the dashboard, which resolves the old plan-page landing for free.

**Keep:** entitlement, the `subscriptions` row and its status, the two gates, and the dunning and banner concepts. That is where comped lives.

Migrations are forward-only, so leave `stripe_events` in place and stop using it.

**This amends the constitution and the spec, which the founder has authorised.** Invariant 16 names the Stripe webhook worker as the only writer of entitlement, and main §4.2 describes signup into a plan screen into Stripe Checkout. Amend the invariant text in `CLAUDE.md` and record both in `DECISIONS.md`.

Watch for the snapshot test holding the literal cap line from main Appendix A. If it lives on the plan page it has to move, not disappear.

*Done when:* nothing imports the Stripe SDK, the gate is green, and a merchant signing in lands on the dashboard.

### 3 — A stalled onboarding run resumes by itself · Lane B

When an ingestion step fails a retryable way the runtime stamps `next_attempt_at`, and `dispatchableSteps` will offer that step again once the time passes. Nothing ever asks. The only callers of the dispatcher are the domain-claim route and the Shopify OAuth callback, so the pilot store can stop halfway through onboarding and show "we'll retry automatically" for ever.

Build the sweep. Migration `0000` already creates `job_steps_dispatch_idx` on `(state, next_attempt_at)` for a query nothing has ever run. Follow `signal_scan_onboarding_sweep` and `publish_intent_recovery_sweep`, the same idea on a five-minute schedule.

The dead-letter replay path has the same hole: it resets a step to pending and nothing dispatches it. Cover both.

Also add a test enumerating every registered task name, asserting each is either on the crontab or has a call site that enqueues it. Three defects in this ledger are jobs nothing enqueues. About thirty lines, and it closes the class.

*Done when:* a run whose first step fails once completes untouched, a replayed dead-letter entry runs, and the census test passes.

### 4 — Detection survives a large home page · Lane B

Platform detection reads the whole body looking for two Shopify markers, and the shared fetcher rejects an oversized response rather than truncating, so a heavy storefront fails and dead-letters. Reproduced: `allbirds.com` fails, `gymshark.com` works. The pilot store may be either.

Settled by the specs, so do not treat it as a choice. Detection passes its own `maxBytes: 600_000`. tech §2 says the single fetcher uses the same budget as the preview endpoint and main §3.2 puts that at about 1.5 MB, which is also the fetcher's default and what the preview passes. The 600 KB is an undocumented tightening with no journal entry. Restore the documented budget.

Keep the underlying cause when the failure is wrapped; today an operator sees only "could not read".

*Done when:* detection succeeds against a home page over the old cap and the log carries the original reason.

### 5 — Publish the writer's Markdown as real HTML · Lane D

**The most important card in the batch.** The writer produces Markdown and the third gate checks Markdown links and tables, but the HTML builder escapes the text and wraps each section body in a single paragraph tag (`packages/core/src/publish/bundle.ts:168`). Internal links, comparison tables, step lists and paragraph breaks would reach the store as literal characters. Only the product tokens become links. No Markdown library is in any `package.json`.

**Start by rendering one fixture article and looking at the HTML.** Two independent reviews inferred this from reading and neither ran it. Confirm before you fix.

Use `markdown-it`, configured so raw HTML in the source is escaped rather than passed through, and check that link targets cannot carry a script scheme. This HTML goes straight into a merchant's storefront, so the safety of the renderer matters more than its features. The dependency belongs to the package that owns the builder.

Finish with a contract test asserting the rendered HTML contains real anchors, tables and paragraphs for a fixture that exercises each.

*Done when:* a fixture article renders to HTML a browser would display correctly, and the contract test locks it.

### 6 — Search Console can actually be connected · Lane C

The merchant grants Google access and lands on Settings, which shows a "connected" message and no picker. No property is chosen, no history import is queued, and the account stays in Limited Intelligence while the screen says it worked. The picker component exists and works; the only screen mounting it is the dashboard, which the callback never returns to, so that mount has never fired.

Carry the return destination in the signed OAuth state, allowlisted to the two known screens. Do not accept an arbitrary path: even a forged state must only be able to choose between two safe values. Then mount the existing picker on Connections too, because ui §9.3 names it there and main §6.7 says connecting from Settings, the dashboard nudge or the Limited Intelligence badge all trigger the same backfill.

The engine reads Search Console before it decides anything, so without this the pilot tests the writer rather than the product.

*Done when:* a merchant starting from onboarding finishes on the dashboard with a property stored, one starting from Settings finishes on Settings with a property stored, and the history import is queued in both cases.

### 7 — The public preview stops answering 500 · Lane A

The preview builds a file URL from the module's own address, which the bundler rewrites into a static asset path with no disk behind it. `packages/llm/src/prompts.ts` already solved this by composing the path instead, and `DECISIONS.md` recommended the switch on 2026-09-01. Nothing blocks it: the rule limiting what the preview may import constrains only files under `packages/core/src/preview/`, and this config already deep-imports the LLM package.

Note in `DECISIONS.md` that the loader reads from the repository tree at call time and `next.config.mjs` does not list the prompts directory under output file tracing. Harmless today, load-bearing the day anyone turns on standalone output.

*Done when:* a preview request returns a card, and the boot smoke check exercises the preview route rather than only the landing page and the health check.

### 8 — The production start command points at a build · Lane G

`railway.toml` runs Next from the repository root while the build output is in `apps/web`. Pass the application directory to `next start`. Do not set the service's working directory instead: that would also move the working directory for the migration that runs before deploy and for the on-disk rules config.

This cannot be verified without deploying and the founder is not deploying yet. Say so in the card and in `DECISIONS.md` rather than claiming it works.

**Do not remove `NEXT_MANUAL_SIG_HANDLE=1`** from those lines. The comment beside it is correct and load-bearing; the journal entry calling it unapplied is stale.

*Done when:* the command names a directory that contains a build, and the limits of that claim are written down.


---

## Batch 2 — The article is right, and published exactly once

A merchant's store is the one place a mistake here is permanent. Three of these publish something wrong; the rest lose work or strand a day. Start with the abandoned claim, because it stops every later publish for that account.

14 findings, 3 high.

| Sev | Finding | Where |
|---|---|---|
| high | An abandoned publish claim permanently blocks every later auto-publish for the account | `packages/jobs/src/publish/auto-publish.ts:403` |
| high | A REFRESH of our own article writes and auto-publishes a brand-new competing article instead of updating the original | `packages/jobs/src/generation/topic-scheduler.ts:132` |
| high | Article writing is capped at 4,000 output tokens while the requested length has no upper bound, so long or non-English articles are cut off and fail | `packages/core/src/generation/draft.ts:172` |
| medium | Recovery sweep posts to Shopify for a store that has since switched delivery back to export | `packages/jobs/src/publish/recovery.ts:218` |
| medium | After a Gate 3 repair, product references are not re-synced to the repaired body | `packages/jobs/src/generation/generate-article.ts:366` |
| medium | A crash between the Shopify post and the day's ledger write can deliver two articles in one day on retry | `packages/jobs/src/publish/deliver.ts:190` |
| medium | An abandoned interrupted writing run leaves its calendar day stuck in 'generating' for ever | `packages/jobs/src/generation/stranded-sweep.ts:93` |
| medium | A suggestion whose article is refused by the quality gate (or discarded in review) stays 'scheduled' for ever | `packages/jobs/src/generation/generate-article.ts:414` |
| medium | A veto landing between 'pick the article' and 'claim the publish' still publishes the article to the merchant's store | `packages/jobs/src/publish/auto-publish.ts:317` |
| medium | Veto during the first minute of writing still produces a 'draft ready for review' on the cancelled day | `packages/jobs/src/generation/daily-cycle.ts:268` |
| medium | Manual topic add writes the opportunity and the topic in separate statements, so a failed topic insert strands an open opportunity | `packages/jobs/src/generation/admit-manual-topic.ts:180` |
| medium | Gate 1 (topic admission) only runs for topics a merchant adds by hand; automatically scheduled topics skip it | `packages/jobs/src/generation/topic-scheduler.ts:69` |
| low | Calendar fill claims the suggestion before placing it; any failure in between strands it as 'scheduled' with no calendar day | `packages/jobs/src/generation/replenish.ts:229` |
| low | Moving a topic onto a day that was filled a moment earlier answers 500, not the 409 conflict code | `packages/jobs/src/generation/move-topic.ts:45` |

## Batch 3 — Work never stops silently

The liveness class, concentrated. A retry budget spent on deliberate hand-offs, mail that never dead-letters, a pause that drops jobs instead of holding them, a weekly pass nothing schedules. The census test from card 3 catches new instances; these are the existing ones.

19 findings, 4 high.

| Sev | Finding | Where |
|---|---|---|
| high | Catalogue walk and distillation budget hand-offs consume the step's retry budget, so large stores can never finish onboarding | `packages/jobs/src/ingestion/catalog.ts:281` |
| high | The minute-by-minute email drain resets a failing email's retry counter, so it never dead-letters | `packages/jobs/src/notify/send-worker.ts:76` |
| high | Network failures and Resend 5xx are classified non-retryable, so a blip permanently drops the email | `packages/providers/src/email/index.ts:71` |
| high | A job that arrives while work is paused is thrown away, not held | `packages/jobs/src/runtime/gate.ts:281` |
| medium | Every catalogue-change drain chain ends in a job that fails the per-account lock check | `packages/jobs/src/inventory/drain.ts:111` |
| medium | Change-stream cursor is lost on every webhook, so each merchant edit re-reads up to 30 days of changes and re-syncs every page they touched | `packages/jobs/src/inventory/drain.ts:72` |
| medium | oauth_wait and awaiting_confirmation have no lease but never actually wait in 'running', so a crash mid-step strands the run forever | `packages/jobs/src/runtime/lease.ts:34` |
| medium | The global pause switch exempts the email drain but not the job that actually sends, so no mail goes out while paused | `packages/jobs/src/runtime/gate.ts:206` |
| medium | When search-data spending is paused, every keyword-pricing job fails instead of stopping quietly | `packages/jobs/src/ingestion/enrich.ts:177` |
| medium | The weekly intent-gap comparison is registered but nothing schedules or enqueues it | `packages/jobs/src/optimize/intent-gap-tasks.ts:139` |
| medium | A Google quota 403 is treated as a revoked Search Console grant and kills the connection | `packages/providers/src/gsc/client.ts:301` |
| low | Intent-gap paid pass has no billing, vacation or deletion gate | `packages/jobs/src/optimize/intent-gap-pass.ts:84` |
| low | Task checklist is lost if the scan dies between the opportunity upsert and the task insert | `packages/jobs/src/scan/run.ts:410` |
| low | Standard-curve fallback is stored and then re-read as a fitted curve | `packages/jobs/src/scan/ctr-curve.ts:97` |
| low | A paused or skipped OPTIMIZE generation promotes a 'new' row to 'accepted' | `packages/jobs/src/optimize/generate.ts:212` |
| low | GSC history import recomputes its chunk boundaries from 'today' on every chunk, so crossing midnight restarts the import | `packages/jobs/src/gsc/backfill.ts:71` |
| low | Nightly sweep records a brand-new deletion for every already-deleted product every night, permanently inflating the 'webhooks are failing' metric | `packages/jobs/src/ingestion/sweep.ts:244` |
| low | A shutdown during SERP reads makes the keywords step succeed with partial data and records it as complete | `packages/jobs/src/ingestion/keywords.ts:427` |
| low | A store that is busy at 05:30 UTC silently loses that day's landing-page revenue | `packages/jobs/src/ingestion/sweep.ts:416` |

## Batch 4 — Money is not burned

The daily search-data cap stops one of six spenders, the weekly scan's purchases are uncapped, and a failed model answer is cached for a day so every retry replays it. Four of seven are high and they compound: an uncapped spender plus a poisoned cache is a bill with nothing to show.

7 findings, 4 high.

| Sev | Finding | Where |
|---|---|---|
| high | Global DataForSEO spend cap does not stop the scan's SERP purchases | `packages/jobs/src/scan/assemble.ts:521` |
| high | A cut-off or malformed model answer is cached for 24 hours, so every retry of the step replays the same failure | `packages/llm/src/client.ts:261` |
| high | Stores in countries the locale detector accepts but the search-data table lacks can never finish onboarding | `packages/providers/src/seo/locations.ts:31` |
| high | The DataForSEO daily spend cap only stops keyword enrichment; every other paid search-data read keeps spending | `packages/jobs/src/sweeps/spend-caps.ts:135` |
| medium | DataForSEO error answers are cached for 24 hours, so a 'retryable' failure can never succeed on retry | `packages/providers/src/seo/index.ts:213` |
| medium | The 'spending far more than normal' brake pauses healthy stores whose typical day is a few tenths of a cent | `packages/core/src/ops/spend-caps.ts:167` |
| low | Keyword difficulty is always empty in production: 'competition' is a string on the endpoint actually called | `packages/providers/src/seo/index.ts:382` |

## Batch 5 — Screens tell the truth

Every one of these is a merchant being told something false or left waiting. None breaks the engine, all break trust. The account-deletion one is here rather than in billing because the race is vendor-agnostic: only what gets closed changes.

22 findings, 2 high.

| Sev | Finding | Where |
|---|---|---|
| high | Deleting an account can leave its Stripe subscription running forever | `apps/web/app/api/account/delete/_lib/handler.ts:52` |
| high | Calendar previous/next month buttons never load that month's topics | `packages/ui/src/content/CalendarScreen.tsx:247` |
| medium | GSC OAuth callback returns a raw 500 when Google refuses the code exchange | `apps/web/app/api/gsc/_lib/handlers.ts:72` |
| medium | Opportunities list always sends scheduledFor: null, so the card shows a Schedule button that 409s once the topic is on the calendar | `apps/web/app/api/opportunities/_lib/handlers.ts:152` |
| medium | Schedule route is check-then-act: two concurrent presses book two calendar days for one opportunity, or one of them crashes on the day-exclusion constraint | `apps/web/app/api/opportunities/_lib/handlers.ts:357` |
| medium | Article review screen never updates after Approve / Discard / Publish anyway / Refresh | `apps/web/app/(app)/content/articles/[articleId]/page.tsx:41` |
| medium | 'Generate recommendations' leaves the drawer on 'generating' forever | `packages/ui/src/opportunities/OpportunitiesScreen.tsx:197` |
| medium | A veto is only sent 5 seconds after the press, and is lost if the tab closes or reloads first | `packages/ui/src/content/actions.ts:154` |
| medium | Confirmation screen: competitor errors are all shown as 'marketplace blocklist', keyword add fails silently, removals are never rolled back | `packages/ui/src/onboarding/ConfirmationSections.tsx:287` |
| medium | First-scan waiting screen has no failure or timeout state and ignores the scan-status route built for it | `packages/ui/src/onboarding/FindingOpportunities.tsx:95` |
| medium | Support, legal and notification links point at pages that do not exist | `packages/ui/src/onboarding/ConnectDomain.tsx:41` |
| medium | The Opportunities nav item spins forever for every merchant | `packages/core/src/account/view.ts:78` |
| medium | The timezone dropdown breaks hydration on Publishing settings | `packages/ui/src/settings/settings.ts:93` |
| medium | Settings accepts any timezone or language string and falls back to UTC silently | `apps/web/app/api/settings/_lib/handlers.ts:98` |
| low | Settings PATCH writes the first half of the body, then rejects the request with 422 | `apps/web/app/api/settings/_lib/handlers.ts:142` |
| low | email_send_state 'delivered' exists in the schema and type but nothing ever writes it | `apps/web/app/api/webhooks/resend/_lib/receiver.ts:85` |
| low | "Date in the past" check for manual topic add uses the UTC calendar day, not the store's timezone | `apps/web/app/api/calendar/topics/_lib/add.ts:59` |
| low | SSE progress streams can throw inside a timer with no handler when the client disconnects mid-tick or the DB read fails | `apps/web/app/api/ingestion/_lib/handlers.ts:94` |
| low | Blank Shopify credentials fake only the consent step; every later Shopify read goes to the real Shopify with a fake token | `apps/web/app/api/shopify/_lib/config.ts:108` |
| low | A blank SHOPIFY_CLIENT_SECRET makes the OAuth state signing key the empty string | `apps/web/app/api/shopify/_lib/config.ts:120` |
| low | A lapsed subscription (402) is reported as 'updated by the latest scan' or 'changed while you had the page open' | `packages/ui/src/opportunities/actions.ts:179` |
| low | Calendar accepts an inverted date range; Connections screen contradicts itself | `various` |

## Batch 6 — Data integrity and the tail

Three highs that bite at real scale: a competitor-gap row that can never be generated, an insert Postgres rejects past about seven thousand rows, and a crash when a keyword already has an opportunity. The rest is the long tail, worth doing when the batches above are clear.

14 findings, 3 high.

| Sev | Finding | Where |
|---|---|---|
| high | Competitor-gap OPTIMIZE rows carry a keyword as their entity and can never be generated | `packages/core/src/opportunities/action-selection.ts:156` |
| high | Search Console rows are written in one giant INSERT with no chunking, which Postgres rejects past about 7,000 rows | `packages/db/src/repositories/search.ts:145` |
| high | Manually adding a topic for a keyword that already has an open opportunity crashes on the dedupe index | `packages/db/src/repositories/opportunities.ts:728` |
| medium | Database constraint violations are never translated, so day collisions and duplicate inserts surface as 500s instead of the promised 409 | `packages/db/src/repositories/topics.ts:296` |
| medium | Every article on the Performance screen is permanently 'too new to judge' with its figures hidden | `packages/core/src/search/performance.ts:302` |
| low | Ten separate PostHog clients exist per process; shutdown flushes only one | `apps/web/instrumentation-node.ts:30` |
| low | A calendar day can hold several articles, but every reader takes an arbitrary one | `packages/db/src/repositories/articles.ts:309` |
| low | Migration 0013 adds the one-topic-per-day constraint without cleaning existing data, so it fails on any database that already holds two non-vetoed topics on a day | `packages/db/migrations/0013_t_wave7_publish_attempts_one_topic_a_day_and_gate_rules_version.sql:41` |
| low | Auto-publish can be switched on against a Shopify connection that is already marked lost, and survives a reconnect that drops the write permission | `packages/db/src/repositories/publishing.ts:140` |
| low | Several repository methods accept an account scope but never use it in the WHERE clause | `packages/db/src/repositories/article-claims.ts:40` |
| low | Keyword cleaning does not apply the search-volume vendor's own keyword rules, so one bad term can fail the whole paid batch | `packages/core/src/keywords/validate.ts:96` |
| low | The rule that override-published articles are kept out of calibration data is enforced only by a function nothing calls | `packages/db/src/repositories/gate-decisions.ts:222` |
| low | The test that proves nothing imports the preview cannot see imports through the core package's front door | `packages/core/src/preview/disposable.test.ts:43` |
| low | The dev seed reports 40 products and inserts none | `packages/db/src/seed.ts:59` |

---

## How you work

**Git.** One commit per card, in the repository's style: a title saying what changed in words, a body explaining why in plain language, no spec section lists. Push as you go. End every commit message with the co-author line the session gives you.

**The gate.** Eleven commands, one at a time, never chained. `pnpm test` and `pnpm lint:prove` share a fixture and must not run together.

```
lint · lint:prove · typecheck · test · contracts:check · build · smoke:boot · smoke:dev · chaos · env:check · stubs:report
```

Plus `db:migrate` against a freshly created empty database whenever migrations change, and `pnpm build` again after `smoke:dev`, which replaces the production build. If Postgres is unreachable, `pnpm db:up`; if Docker is not running, start it.

**Schema.** Migrations land only in schema-wave cards. Card 1 needs one: file the `DECISIONS.md` entry and ask for a mini-wave rather than adding a migration yourself.

**When you are blocked.** The founder is away. If a card needs a decision that is not in the table above, write the question into `DECISIONS.md` in plain terms, skip that card, and move to the next. Do not stop the session, and do not guess at a user-visible behaviour nobody chose.

**Run the product.** After each card, start the app and walk the journey it touched. Three of the criticals in this ledger were found in the first twenty minutes of doing that, and none by the gate. `node scripts/dev.mjs` starts it with the repository's environment. To sign in without Google, insert a `sessions` row whose `session_token` is the SHA-256 hex digest of your cookie value, then send `authjs.session-token=<the plain value>`.

**Your report.** Per card: what externally visible behaviour changed, why the old behaviour was not enough, the two or three things most worth scrutinising, and anything you left out. For card 0, the scores. Written for someone who has not read the code.

