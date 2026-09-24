# What to fix, and what to drop

Written 2026-09-24. Every open defect split by one question: **does this code still exist after the Shopify App Store rebuild?**

The rebuild replaces the shell and keeps the engine. Roadmap step 7 drops domain entry, platform detection and the separate Shopify connection step. Step 5 replaces the cookie session and the sign-in page with Shopify session tokens through App Bridge. Step 6 withdraws Stripe for Shopify stores and lets Shopify render the plan picker. Step 1 keeps the sortiva.app analysis as a marketing page.

Everything behind that shell is untouched by how the product is distributed: ingestion, Search Console, signals, opportunities, the calendar, the quality gates, writing, publishing, the learning loop, notifications, spend caps, the job runtime and the database.

| | Count |
|---|---|
| Fix, it is the engine | 80 |
| Drop, it dies with the shell | 12 |
| Already closed by the Shopify merge | 13 |

Severity is what a merchant or operator experiences, not code hygiene.

---

## Drop (12)

Real defects, on code the rebuild deletes.

**Onboarding**

- **critical** — Platform detection fails on a home page over 600 KB · seen live  
  `packages/jobs/src/ingestion/steps.ts:170`  
  detection disappears: the store domain comes from the install
- **medium** — Support, legal and notification links point at pages that do not exist  
  `packages/ui/src/onboarding/ConnectDomain.tsx:41`  
  the screen dies, but working support and legal pages are required for an App Store listing anyway

**Billing**

- **high** — Stripe events arriving during an in-flight drain stay unprocessed until some unrelated webhook arrives  
  `apps/web/app/api/webhooks/stripe/_lib/receiver.ts:105`
- **high** — The queued Stripe drain job is registered but nothing ever enqueues it; webhook processing is a fire-and-forget promise inside the web request  
  `apps/web/app/api/webhooks/stripe/_lib/tasks.ts:35`
- **high** — Stripe events that can never be resolved pile up at the front of the queue until billing stops processing anything  
  `packages/core/src/billing/processing.ts:424`
- **config** — The Stripe price ids in .env are literal amounts, not price ids · seen live  
  `(.env)`
- **medium** — Checkout idempotency key ignores the inputs that change, so a second checkout within 24h can be refused by Stripe  
  `packages/core/src/billing/checkout.ts:61`
- **medium** — An event about a merchant's old or abandoned Stripe subscription overwrites their live one, and the nightly repair then keeps it wrong  
  `packages/core/src/billing/processing.ts:213`
- **low** — Billing routes answer a bare 500 instead of the 503 envelope, both when Stripe rejects the request and when the key is unset  
  `apps/web/app/api/billing/_lib/handlers.ts:119`

**Auth and sign-in**

- **high** — Every sign-in lands on the plan page with a live Subscribe button, and checkout does not refuse an already-subscribed account  
  `packages/ui/src/public/signin-exchange.ts:33`
- **high** — Every app screen renders without a signed-in session · seen live  
  `apps/web/app/(app)/_lib/shell-state.ts`  
  there is no sign-in page in an embedded app
- **low** — A deleted account can sign back in and reach every scoped route except /api/account and billing  
  `apps/web/app/api/auth/_lib/adapter.ts:95`

**One decision settles most of this.** Roadmap step 3 says the pilot either keeps Stripe or runs free. If the pilot stores are free, every billing finding above is dropped outright today. If they pay through Stripe, two must be fixed first: a paying merchant can stay unentitled because nothing enqueues the drain, and one unresolvable event stops billing processing everything behind it.

**Two are worth doing anyway, for a reason other than the bug.** The missing support and legal pages are required for an App Store listing. And the Shopify credential handling under Auth stays in some form, because an embedded app still exchanges a token.

---

## Fix (80)

The engine. Grouped by area, worst first, and ordered so the areas with the most severe findings come first.

### Job runtime (4)

- **critical** — Onboarding stops at the first step and the screen says it will retry · seen live  
  `apps/web/app/api/domain/_lib/store.ts:158`  
  the retry sweep is form-independent, even though the domain-claim route that triggers it today disappears
- **high** — A job that arrives while work is paused is thrown away, not held  
  `packages/jobs/src/runtime/gate.ts:281`
- **medium** — oauth_wait and awaiting_confirmation have no lease but never actually wait in 'running', so a crash mid-step strands the run forever  
  `packages/jobs/src/runtime/lease.ts:34`
- **medium** — The global pause switch exempts the email drain but not the job that actually sends, so no mail goes out while paused  
  `packages/jobs/src/runtime/gate.ts:206`

### Preview (2)

- **critical** — The public preview returns a 500 before reaching any vendor · seen live  
  `apps/web/app/api/preview/_lib/config.ts:93`  
  the analysis stays as a marketing page
- **low** — The test that proves nothing imports the preview cannot see imports through the core package's front door  
  `packages/core/src/preview/disposable.test.ts:43`

### Writing (10)

- **high** — A REFRESH of our own article writes and auto-publishes a brand-new competing article instead of updating the original  
  `packages/jobs/src/generation/topic-scheduler.ts:132`
- **high** — Article writing is capped at 4,000 output tokens while the requested length has no upper bound, so long or non-English articles are cut off and fail  
  `packages/core/src/generation/draft.ts:172`
- **medium** — After a Gate 3 repair, product references are not re-synced to the repaired body  
  `packages/jobs/src/generation/generate-article.ts:366`
- **medium** — An abandoned interrupted writing run leaves its calendar day stuck in 'generating' for ever  
  `packages/jobs/src/generation/stranded-sweep.ts:93`
- **medium** — A suggestion whose article is refused by the quality gate (or discarded in review) stays 'scheduled' for ever  
  `packages/jobs/src/generation/generate-article.ts:414`
- **medium** — Veto during the first minute of writing still produces a 'draft ready for review' on the cancelled day  
  `packages/jobs/src/generation/daily-cycle.ts:268`
- **medium** — Manual topic add writes the opportunity and the topic in separate statements, so a failed topic insert strands an open opportunity  
  `packages/jobs/src/generation/admit-manual-topic.ts:180`
- **medium** — Gate 1 (topic admission) only runs for topics a merchant adds by hand; automatically scheduled topics skip it  
  `packages/jobs/src/generation/topic-scheduler.ts:69`
- **low** — Calendar fill claims the suggestion before placing it; any failure in between strands it as 'scheduled' with no calendar day  
  `packages/jobs/src/generation/replenish.ts:229`
- **low** — Moving a topic onto a day that was filled a moment earlier answers 500, not the 409 conflict code  
  `packages/jobs/src/generation/move-topic.ts:45`

### Database (8)

- **high** — Search Console rows are written in one giant INSERT with no chunking, which Postgres rejects past about 7,000 rows  
  `packages/db/src/repositories/search.ts:145`
- **high** — Manually adding a topic for a keyword that already has an open opportunity crashes on the dedupe index  
  `packages/db/src/repositories/opportunities.ts:728`
- **medium** — Database constraint violations are never translated, so day collisions and duplicate inserts surface as 500s instead of the promised 409  
  `packages/db/src/repositories/topics.ts:296`
- **low** — A calendar day can hold several articles, but every reader takes an arbitrary one  
  `packages/db/src/repositories/articles.ts:309`
- **low** — Migration 0013 adds the one-topic-per-day constraint without cleaning existing data, so it fails on any database that already holds two non-vetoed topics on a day  
  `packages/db/migrations/0013_t_wave7_publish_attempts_one_topic_a_day_and_gate_rules_version.sql:41`
- **low** — Auto-publish can be switched on against a Shopify connection that is already marked lost, and survives a reconnect that drops the write permission  
  `packages/db/src/repositories/publishing.ts:140`
- **low** — Several repository methods accept an account scope but never use it in the WHERE clause  
  `packages/db/src/repositories/article-claims.ts:40`
- **low** — The rule that override-published articles are kept out of calibration data is enforced only by a function nothing calls  
  `packages/db/src/repositories/gate-decisions.ts:222`

### Catalogue ingestion (5)

- **high** — Catalogue walk and distillation budget hand-offs consume the step's retry budget, so large stores can never finish onboarding  
  `packages/jobs/src/ingestion/catalog.ts:281`
- **medium** — When search-data spending is paused, every keyword-pricing job fails instead of stopping quietly  
  `packages/jobs/src/ingestion/enrich.ts:177`
- **low** — Nightly sweep records a brand-new deletion for every already-deleted product every night, permanently inflating the 'webhooks are failing' metric  
  `packages/jobs/src/ingestion/sweep.ts:244`
- **low** — A shutdown during SERP reads makes the keywords step succeed with partial data and records it as complete  
  `packages/jobs/src/ingestion/keywords.ts:427`
- **low** — A store that is busy at 05:30 UTC silently loses that day's landing-page revenue  
  `packages/jobs/src/ingestion/sweep.ts:416`

### Publishing (5)

- **high** — An abandoned publish claim permanently blocks every later auto-publish for the account  
  `packages/jobs/src/publish/auto-publish.ts:403`
- **high** — Auto-published article body is Markdown wrapped in <p> tags, not HTML  
  `packages/core/src/publish/bundle.ts:168`
- **medium** — Recovery sweep posts to Shopify for a store that has since switched delivery back to export  
  `packages/jobs/src/publish/recovery.ts:218`
- **medium** — A crash between the Shopify post and the day's ledger write can deliver two articles in one day on retry  
  `packages/jobs/src/publish/deliver.ts:190`
- **medium** — A veto landing between 'pick the article' and 'claim the publish' still publishes the article to the merchant's store  
  `packages/jobs/src/publish/auto-publish.ts:317`

### Weekly scan (3)

- **high** — Global DataForSEO spend cap does not stop the scan's SERP purchases  
  `packages/jobs/src/scan/assemble.ts:521`
- **low** — Task checklist is lost if the scan dies between the opportunity upsert and the task insert  
  `packages/jobs/src/scan/run.ts:410`
- **low** — Standard-curve fallback is stored and then re-read as a fitted curve  
  `packages/jobs/src/scan/ctr-curve.ts:97`

### Search-data vendor (3)

- **high** — Stores in countries the locale detector accepts but the search-data table lacks can never finish onboarding  
  `packages/providers/src/seo/locations.ts:31`
- **medium** — DataForSEO error answers are cached for 24 hours, so a 'retryable' failure can never succeed on retry  
  `packages/providers/src/seo/index.ts:213`
- **low** — Keyword difficulty is always empty in production: 'competition' is a string on the endpoint actually called  
  `packages/providers/src/seo/index.ts:382`

### Search Console routes (2)

- **high** — Search Console connect never reaches the property picker, so the connection can never be completed  
  `apps/web/app/api/gsc/_lib/config.ts:33`
- **medium** — GSC OAuth callback returns a raw 500 when Google refuses the code exchange  
  `apps/web/app/api/gsc/_lib/handlers.ts:72`

### Content screens (2)

- **high** — Calendar previous/next month buttons never load that month's topics  
  `packages/ui/src/content/CalendarScreen.tsx:247`
- **medium** — A veto is only sent 5 seconds after the press, and is lost if the tab closes or reloads first  
  `packages/ui/src/content/actions.ts:154`

### Account lifecycle (1)

- **high** — Deleting an account can leave its Stripe subscription running forever  
  `apps/web/app/api/account/delete/_lib/handler.ts:52`  
  the race is vendor-agnostic; only what gets closed changes from Stripe to Shopify

### Opportunities (1)

- **high** — Competitor-gap OPTIMIZE rows carry a keyword as their entity and can never be generated  
  `packages/core/src/opportunities/action-selection.ts:156`

### Email and notifications (1)

- **high** — The minute-by-minute email drain resets a failing email's retry counter, so it never dead-letters  
  `packages/jobs/src/notify/send-worker.ts:76`

### Deployment (1)

- **high** — The production start command runs 'next start' from the repo root, where there is no build  
  `railway.toml:38`

### Email vendor (1)

- **high** — Network failures and Resend 5xx are classified non-retryable, so a blip permanently drops the email  
  `packages/providers/src/email/index.ts:71`

### Model client (1)

- **high** — A cut-off or malformed model answer is cached for 24 hours, so every retry of the step replays the same failure  
  `packages/llm/src/client.ts:261`

### Sweeps (1)

- **high** — The DataForSEO daily spend cap only stops keyword enrichment; every other paid search-data read keeps spending  
  `packages/jobs/src/sweeps/spend-caps.ts:135`

### Optimize recommendations (3)

- **medium** — The weekly intent-gap comparison is registered but nothing schedules or enqueues it  
  `packages/jobs/src/optimize/intent-gap-tasks.ts:139`
- **low** — Intent-gap paid pass has no billing, vacation or deletion gate  
  `packages/jobs/src/optimize/intent-gap-pass.ts:84`
- **low** — A paused or skipped OPTIMIZE generation promotes a 'new' row to 'accepted'  
  `packages/jobs/src/optimize/generate.ts:212`

### Opportunity routes (2)

- **medium** — Opportunities list always sends scheduledFor: null, so the card shows a Schedule button that 409s once the topic is on the calendar  
  `apps/web/app/api/opportunities/_lib/handlers.ts:152`
- **medium** — Schedule route is check-then-act: two concurrent presses book two calendar days for one opportunity, or one of them crashes on the day-exclusion constraint  
  `apps/web/app/api/opportunities/_lib/handlers.ts:357`

### Catalogue change stream (2)

- **medium** — Every catalogue-change drain chain ends in a job that fails the per-account lock check  
  `packages/jobs/src/inventory/drain.ts:111`
- **medium** — Change-stream cursor is lost on every webhook, so each merchant edit re-reads up to 30 days of changes and re-syncs every page they touched  
  `packages/jobs/src/inventory/drain.ts:72`

### Settings routes (2)

- **medium** — Settings accepts any timezone or language string and falls back to UTC silently · seen live  
  `apps/web/app/api/settings/_lib/handlers.ts:98`
- **low** — Settings PATCH writes the first half of the body, then rejects the request with 422  
  `apps/web/app/api/settings/_lib/handlers.ts:142`

### Opportunity screens (2)

- **medium** — 'Generate recommendations' leaves the drawer on 'generating' forever  
  `packages/ui/src/opportunities/OpportunitiesScreen.tsx:197`
- **low** — A lapsed subscription (402) is reported as 'updated by the latest scan' or 'changed while you had the page open'  
  `packages/ui/src/opportunities/actions.ts:179`  
  the entitlement refusal survives; only the word Stripe changes

### Onboarding (2)

- **medium** — Confirmation screen: competitor errors are all shown as 'marketplace blocklist', keyword add fails silently, removals are never rolled back  
  `packages/ui/src/onboarding/ConfirmationSections.tsx:287`
- **medium** — First-scan waiting screen has no failure or timeout state and ignores the scan-status route built for it  
  `packages/ui/src/onboarding/FindingOpportunities.tsx:95`

### Google vendor (1)

- **medium** — A Google quota 403 is treated as a revoked Search Console grant and kills the connection  
  `packages/providers/src/gsc/client.ts:301`

### Kill switches and caps (1)

- **medium** — The 'spending far more than normal' brake pauses healthy stores whose typical day is a few tenths of a cent  
  `packages/core/src/ops/spend-caps.ts:167`

### App screens (1)

- **medium** — Article review screen never updates after Approve / Discard / Publish anyway / Refresh  
  `apps/web/app/(app)/content/articles/[articleId]/page.tsx:41`

### Search Console (1)

- **medium** — Every article on the Performance screen is permanently 'too new to judge' with its figures hidden  
  `packages/core/src/search/performance.ts:302`

### App shell (1)

- **medium** — The Opportunities nav item spins forever for every merchant · seen live  
  `packages/core/src/account/view.ts:78`

### Settings screens (1)

- **medium** — The timezone dropdown breaks hydration on Publishing settings · seen live  
  `packages/ui/src/settings/settings.ts:93`

### Shopify connection (2)

- **low** — Blank Shopify credentials fake only the consent step; every later Shopify read goes to the real Shopify with a fake token  
  `apps/web/app/api/shopify/_lib/config.ts:108`
- **low** — A blank SHOPIFY_CLIENT_SECRET makes the OAuth state signing key the empty string  
  `apps/web/app/api/shopify/_lib/config.ts:120`

### Email webhook (1)

- **low** — email_send_state 'delivered' exists in the schema and type but nothing ever writes it  
  `apps/web/app/api/webhooks/resend/_lib/receiver.ts:85`

### Calendar routes (1)

- **low** — "Date in the past" check for manual topic add uses the UTC calendar day, not the store's timezone  
  `apps/web/app/api/calendar/topics/_lib/add.ts:59`

### Ingestion routes (1)

- **low** — SSE progress streams can throw inside a timer with no handler when the client disconnects mid-tick or the DB read fails  
  `apps/web/app/api/ingestion/_lib/handlers.ts:94`

### Search Console sync (1)

- **low** — GSC history import recomputes its chunk boundaries from 'today' on every chunk, so crossing midnight restarts the import  
  `packages/jobs/src/gsc/backfill.ts:71`

### Boot (1)

- **low** — Ten separate PostHog clients exist per process; shutdown flushes only one  
  `apps/web/instrumentation-node.ts:30`

### Keywords (1)

- **low** — Keyword cleaning does not apply the search-volume vendor's own keyword rules, so one bad term can fail the whole paid batch  
  `packages/core/src/keywords/validate.ts:96`

### Dev tooling (1)

- **low** — The dev seed reports 40 products and inserts none · seen live  
  `packages/db/src/seed.ts:59`

### Mixed (1)

- **low** — Calendar accepts an inverted date range; Connections screen contradicts itself; Turnstile key invalid on localhost · seen live  
  `various`

